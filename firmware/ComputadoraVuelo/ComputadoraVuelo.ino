/*
  GCE Berisso - Computadora de vuelo para cohetes (taller escolar)

  Placa: Arduino Nano (ATmega328P)
  Sensor: BMP280 por I2C (presion + temperatura)
  Almacenamiento: modulo microSD por SPI (CS en D4)

  Maquina de estados:
    ERROR -> CALIBRANDO -> ARMADO -> GRABANDO -> SENAL -> CALIBRANDO -> ...

  El archivo de salida (VUELO001.TXT ...) tiene un formato fijo que lee el
  visor web. No cambiar el formato sin actualizar el visor.
*/

#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <Adafruit_BMP280.h>

// ============================================================================
//                         CONFIGURACION (editar aca)
// ============================================================================

// ---- Pines ----
#define SD_CS_PIN        4      // Chip Select del modulo microSD
#define STATUS_PIN       5      // LED o buzzer activo externo (NO usar D13: es SCK)
#define USAR_INDICADOR   1      // 1 = usar LED/buzzer en STATUS_PIN, 0 = desactivado

// ---- Sensor ----
#define BMP_DIRECCION_1  0x76   // Direcciones I2C a probar, en orden
#define BMP_DIRECCION_2  0x77
#define BMP_CHIP_ID_1    0x58   // BMP280 original
#define BMP_CHIP_ID_2    0x60   // BME280 (tambien sirve para presion y temperatura)
#define SENSOR_INVALIDO_MS 1000UL // Lecturas invalidas seguidas tolerables antes de dar error
#define CAL_TIMEOUT_MS     10000UL // Tiempo maximo de calibracion

// ---- Muestreo ----
#define FRECUENCIA_HZ    20                       // Muestras por segundo
#define PERIODO_MS       (1000UL / FRECUENCIA_HZ) // 50 ms
#define PRE_SEGUNDOS_X10 15                       // Historial previo al despegue: 1,5 s
#define PRE_MUESTRAS     ((PRE_SEGUNDOS_X10 * FRECUENCIA_HZ) / 10)  // 30 muestras
#define BUF_N            (PRE_MUESTRAS + 1)       // + la muestra que dispara el despegue

// ---- Calibracion del suelo ----
#define CAL_MUESTRAS     50     // Lecturas a promediar para p0
#define CAL_PERIODO_MS   40     // Una lectura cada 40 ms (~2 s en total)

// ---- Deteccion de despegue ----
#define DESPEGUE_ALT_M       4.0f   // Altitud que hay que superar...
#define DESPEGUE_MUESTRAS    3      // ...durante esta cantidad de muestras seguidas

// ---- Correccion lenta de p0 mientras esta armado (deriva del clima) ----
#define DERIVA_ALFA          0.001f // EMA muy lento: constante de tiempo ~50 s a 20 Hz
#define DERIVA_VENTANA_M     1.0f   // Solo corrige si |altitud| < este valor

// ---- Aterrizaje ----
#define ATERRIZAJE_BANDA_M   3.0f      // Dentro de +-3 m del suelo...
#define ATERRIZAJE_MS        5000UL    // ...durante 5 s seguidos
#define GRABACION_MAX_MS     300000UL  // Tope de 5 minutos de grabacion

// ---- Archivo ----
#define FLUSH_PERIODO_MS     1000UL    // flush() como maximo una vez por segundo
#define VUELO_MAX            999       // VUELO001.TXT ... VUELO999.TXT

// ---- Indicador (STATUS_PIN) ----
#define IND_ERROR_MS         100       // Error: parpadeo rapido (cambia cada 100 ms)
#define IND_ARMADO_PERIODO   2000UL    // Armado: un pulso cada 2 s
#define IND_ARMADO_PULSO     60UL      // duracion del pulso
#define IND_PITIDO_MS        250UL     // Vuelo guardado: duracion de cada pitido y pausa
#define IND_PITIDOS_MAX      20        // Tope de pitidos (vuelos > 20 pitan 20 veces)

// ---- Otros ----
#define REINTENTO_MS         2000UL    // Reintento de inicializacion si hay error
#define SERIAL_BAUD          115200

// ============================================================================
//                              ESTADO GLOBAL
// ============================================================================

enum Estado : uint8_t {
  ESTADO_ERROR,
  ESTADO_CALIBRANDO,
  ESTADO_ARMADO,
  ESTADO_GRABANDO,
  ESTADO_SENAL
};

Adafruit_BMP280 bmp;
File archivo;

Estado estado = ESTADO_ERROR;
bool bmpOk = false;
bool sdOk = false;

float p0 = 101325.0f;            // Presion del suelo (Pa)

// Temporizacion del muestreo
uint32_t proxMuestra = 0;

// Calibracion
uint8_t  calN = 0;
float    calRef = 0;
float    calSuma = 0;            // Suma de (p - calRef) para no perder precision
uint32_t calProx = 0;

// Buffer circular previo al despegue (12 bytes por muestra)
uint32_t bufMs[BUF_N];
float    bufP[BUF_N];
uint8_t  bufIdx = 0;             // Proxima posicion a escribir
uint8_t  bufCuenta = 0;          // Cantidad de muestras validas

uint8_t  seguidasAlto = 0;       // Muestras consecutivas sobre el umbral de despegue
float    ultimaTemp = 0;

// Vuelo
uint16_t numVuelo = 0;           // Numero del vuelo que se va a grabar (0 = no hay)
char     nombreArchivo[13];      // "VUELO001.TXT"
uint32_t t0 = 0;                 // millis() del despegue
float    altMax = 0;
int32_t  relApogeoMs = 0;
int32_t  relUltimaMs = 0;
bool     enBanda = false;
uint32_t bandaInicio = 0;
uint32_t ultimoFlush = 0;
uint32_t tamanoPrev = 0;         // Tamano del archivo en el ultimo flush (para detectar fallos de SD)
uint32_t calInicio = 0;
uint32_t invalidaDesde = 0;      // millis() de la primera lectura invalida de la racha
bool     hayInvalida = false;

// Indicador
uint32_t errProx = 0;
uint8_t  pitidosRest = 0;
bool     pitidoEncendido = false;
bool     pitidoPrimero = true;
uint32_t pitidoT = 0;

// ============================================================================
//                              INDICADOR
// ============================================================================

static inline void indicador(bool encendido) {
#if USAR_INDICADOR
  digitalWrite(STATUS_PIN, encendido ? HIGH : LOW);
#else
  (void)encendido;
#endif
}

// Patrones no bloqueantes segun el estado.
void actualizarIndicador(uint32_t ahora) {
  switch (estado) {
    case ESTADO_ERROR:
      indicador((ahora / IND_ERROR_MS) & 1);        // Parpadeo rapido continuo
      break;
    case ESTADO_ARMADO:
      indicador((ahora % IND_ARMADO_PERIODO) < IND_ARMADO_PULSO);  // Pulso corto cada 2 s
      break;
    case ESTADO_GRABANDO:
      indicador(true);                              // Fijo
      break;
    case ESTADO_SENAL:
      indicador(pitidoEncendido);                   // Lo maneja avanzarSenal()
      break;
    default:
      indicador(false);
      break;
  }
}

// Avanza la secuencia de pitidos. Devuelve true cuando termino.
bool avanzarSenal(uint32_t ahora) {
  uint32_t dt = ahora - pitidoT;
  if (pitidoEncendido) {
    if (dt >= IND_PITIDO_MS) {
      pitidoEncendido = false;
      pitidoT = ahora;
      if (pitidosRest > 0) pitidosRest--;
    }
  } else {
    uint32_t espera = pitidoPrimero ? (2 * IND_PITIDO_MS) : IND_PITIDO_MS;
    if (dt >= espera) {
      if (pitidosRest == 0) return true;
      pitidoPrimero = false;
      pitidoEncendido = true;
      pitidoT = ahora;
    }
  }
  return false;
}

// ============================================================================
//                         SENSOR, SD Y ARCHIVO
// ============================================================================

// Inicializa lo que falte (BMP280 y/o SD). Devuelve true si ambos estan bien.
bool iniciarHardware() {
  if (!bmpOk) {
    // Se prueba cada direccion con el ID de BMP280 (0x58) y luego con el de BME280 (0x60)
    bmpOk = bmp.begin(BMP_DIRECCION_1, BMP_CHIP_ID_1) || bmp.begin(BMP_DIRECCION_2, BMP_CHIP_ID_1) ||
            bmp.begin(BMP_DIRECCION_1, BMP_CHIP_ID_2) || bmp.begin(BMP_DIRECCION_2, BMP_CHIP_ID_2);
    if (bmpOk) {
      bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                      Adafruit_BMP280::SAMPLING_X2,     // temperatura
                      Adafruit_BMP280::SAMPLING_X16,    // presion
                      Adafruit_BMP280::FILTER_X4,
                      Adafruit_BMP280::STANDBY_MS_1);
      hayInvalida = false;
      Serial.println(F("BMP280 OK"));
    } else {
      Serial.println(F("ERROR: no se encontro el BMP280/BME280 (0x76 / 0x77). Revisar cables SDA/SCL."));
    }
  }
  if (!sdOk) {
    SD.end();
    sdOk = SD.begin(SD_CS_PIN);
    if (sdOk) {
      Serial.println(F("SD OK"));
    } else {
      Serial.println(F("ERROR: no se pudo iniciar la SD. Revisar tarjeta (FAT32), cables y CS en D4."));
    }
  }
  return bmpOk && sdOk;
}

void irAError();

// Lee presion y temperatura. Devuelve false si la lectura no es valida.
// Si las lecturas invalidas duran mas de SENSOR_INVALIDO_MS, pasa a ERROR.
bool leerSensor(float &p, float &t) {
  t = bmp.readTemperature();
  p = bmp.readPressure();
  if (isnan(p) || isnan(t) || p < 30000.0f || p > 125000.0f) {
    uint32_t ahora = millis();
    if (!hayInvalida) { hayInvalida = true; invalidaDesde = ahora; }
    else if ((ahora - invalidaDesde) > SENSOR_INVALIDO_MS) {
      Serial.println(F("ERROR: el BMP280 no responde (lecturas invalidas)."));
      hayInvalida = false;
      bmpOk = false;
      irAError();
    }
    return false;
  }
  hayInvalida = false;
  return true;
}

float altitudRelativa(float p) {
  return 44330.0f * (1.0f - pow(p / p0, 0.1903f));
}

// Busca el primer VUELOnnn.TXT libre. Devuelve true si hay uno.
// Prueba de escritura: confirma que la tarjeta esta y se puede escribir.
bool probarSD() {
  File f = SD.open("PRUEBA.TMP", FILE_WRITE);
  if (!f) return false;
  bool ok = (f.print('x') > 0);
  f.flush();
  ok = ok && (f.size() > 0);
  f.close();
  SD.remove("PRUEBA.TMP");
  return ok;
}

bool buscarArchivoLibre() {
  if (!probarSD()) { numVuelo = 0; return false; }
  for (uint16_t n = 1; n <= VUELO_MAX; n++) {
    // Arma "VUELOnnn.TXT" a mano (evita snprintf, que ocupa mucha flash)
    nombreArchivo[0] = 'V'; nombreArchivo[1] = 'U'; nombreArchivo[2] = 'E';
    nombreArchivo[3] = 'L'; nombreArchivo[4] = 'O';
    nombreArchivo[5] = '0' + (n / 100);
    nombreArchivo[6] = '0' + ((n / 10) % 10);
    nombreArchivo[7] = '0' + (n % 10);
    nombreArchivo[8] = '.'; nombreArchivo[9] = 'T'; nombreArchivo[10] = 'X';
    nombreArchivo[11] = 'T'; nombreArchivo[12] = 0;
    if (!SD.exists(nombreArchivo)) {
      numVuelo = n;
      return true;
    }
  }
  numVuelo = 0;
  return false;
}

// Escribe un tiempo en segundos con 3 decimales a partir de milisegundos
// enteros (sin usar floats ni printf). Ej: -1450 -> "-1.450"
void imprimirSegundos(Print &salida, int32_t ms) {
  if (ms < 0) { salida.print('-'); ms = -ms; }
  salida.print((long)(ms / 1000));
  salida.print('.');
  uint16_t resto = ms % 1000;
  if (resto < 100) salida.print('0');
  if (resto < 10) salida.print('0');
  salida.print(resto);
}

// Escribe una linea de muestra: tiempo_s,altitud_m,presion_Pa,temperatura_C
bool escribirMuestra(uint32_t ms, float alt, float p, float temp) {
  imprimirSegundos(archivo, (int32_t)(ms - t0));
  archivo.print(',');
  archivo.print(alt, 2);
  archivo.print(',');
  archivo.print(p, 1);
  archivo.print(',');
  archivo.print(temp, 1);
  return archivo.print('\n') > 0;
}

void registrarMaximo(uint32_t ms, float alt) {
  if (alt > altMax) {
    altMax = alt;
    relApogeoMs = (int32_t)(ms - t0);
  }
}

// ============================================================================
//                            TRANSICIONES
// ============================================================================

void irAError() {
  estado = ESTADO_ERROR;
  errProx = millis() + REINTENTO_MS;
  if (archivo) archivo.close();
}

void irACalibrar() {
  calN = 0;
  calSuma = 0;
  calProx = millis();
  calInicio = calProx;
  hayInvalida = false;
  estado = ESTADO_CALIBRANDO;
  Serial.println(F("Calibrando presion del suelo..."));
}

void irAArmado() {
  bufIdx = 0;
  bufCuenta = 0;
  seguidasAlto = 0;
  // Se busca el nombre del proximo archivo ahora para no demorar el despegue
  if (!buscarArchivoLibre()) {
    Serial.println(F("ERROR: la SD no responde, no se puede escribir o tiene los 999 vuelos."));
    sdOk = false;
    irAError();
    return;
  }
  proxMuestra = millis() + PERIODO_MS;
  estado = ESTADO_ARMADO;
  Serial.print(F("ARMADO. p0 = "));
  Serial.print(p0, 1);
  Serial.print(F(" Pa. Proximo archivo: "));
  Serial.println(nombreArchivo);
}

// Despegue detectado: abre archivo, escribe encabezado y el buffer previo.
void iniciarGrabacion() {
  // La ultima muestra guardada en el buffer es la que disparo el despegue
  uint8_t ultimo = (bufIdx + BUF_N - 1) % BUF_N;
  t0 = bufMs[ultimo];

  // Se vuelve a chequear que el nombre siga libre (la SD pudo cambiar)
  if (SD.exists(nombreArchivo) && !buscarArchivoLibre()) {
    Serial.println(F("ERROR: no se encontro un nombre de archivo libre. Vuelo perdido."));
    sdOk = false;
    irAError();
    return;
  }
  archivo = SD.open(nombreArchivo, FILE_WRITE);
  if (!archivo) {
    Serial.println(F("ERROR: no se pudo abrir el archivo. Vuelo perdido."));
    sdOk = false;
    irAError();
    return;
  }

  archivo.print(F("# GCE Berisso - Computadora de vuelo\n"));
  archivo.print(F("# vuelo: "));
  archivo.print(numVuelo);
  archivo.print(F("\n# presion_suelo_Pa: "));
  archivo.print(p0, 1);
  archivo.print(F("\n# frecuencia_Hz: "));
  archivo.print(FRECUENCIA_HZ);
  archivo.print(F("\n# columnas: tiempo_s,altitud_m,presion_Pa,temperatura_C\n"));

  altMax = -1000.0f;
  relApogeoMs = 0;
  uint8_t i = (bufCuenta < BUF_N) ? 0 : bufIdx;   // la mas vieja
  bool ok = true;
  for (uint8_t k = 0; k < bufCuenta; k++) {
    // La altitud se recalcula con el p0 final (no se guarda en el buffer para ahorrar RAM)
    float alt = altitudRelativa(bufP[i]);
    ok = escribirMuestra(bufMs[i], alt, bufP[i], ultimaTemp) && ok;
    registrarMaximo(bufMs[i], alt);
    i = (i + 1) % BUF_N;
  }
  relUltimaMs = 0;
  enBanda = false;
  ultimoFlush = millis();
  archivo.flush();
  tamanoPrev = archivo.size();
  if (!ok || tamanoPrev == 0) {
    Serial.println(F("ERROR: falla de escritura en la SD. Vuelo perdido."));
    sdOk = false;
    irAError();
    return;
  }
  estado = ESTADO_GRABANDO;
  Serial.print(F("DESPEGUE. Grabando en "));
  Serial.println(nombreArchivo);
}

void finalizarVuelo(bool portiempo) {
  uint32_t tamAntes = archivo.size();
  bool ok = (archivo.print(F("# altitud_max_m: ")) > 0);
  archivo.print(altMax, 2);
  archivo.print(F("\n# tiempo_apogeo_s: "));
  imprimirSegundos(archivo, relApogeoMs);
  archivo.print(F("\n# duracion_s: "));
  imprimirSegundos(archivo, relUltimaMs);
  ok = (archivo.print('\n') > 0) && ok;
  archivo.flush();
  ok = ok && (archivo.size() > tamAntes);
  archivo.close();
  if (!ok) {
    Serial.println(F("ERROR: no se pudo escribir el resumen en la SD. Vuelo posiblemente incompleto."));
    sdOk = false;
    irAError();
    return;
  }

  Serial.println(portiempo ? F("Fin por tiempo maximo.") : F("Aterrizaje detectado."));
  Serial.print(F("Vuelo "));
  Serial.print(numVuelo);
  Serial.print(F(" guardado en "));
  Serial.println(nombreArchivo);
  Serial.print(F("  Altitud max: "));
  Serial.print(altMax, 2);
  Serial.println(F(" m"));
  Serial.print(F("  Apogeo a los: "));
  imprimirSegundos(Serial, relApogeoMs);
  Serial.println(F(" s"));
  Serial.print(F("  Duracion: "));
  imprimirSegundos(Serial, relUltimaMs);
  Serial.println(F(" s"));

  pitidosRest = (numVuelo > IND_PITIDOS_MAX) ? IND_PITIDOS_MAX : (uint8_t)numVuelo;
  pitidoEncendido = false;
  pitidoPrimero = true;
  pitidoT = millis();
  estado = ESTADO_SENAL;
}

// ============================================================================
//                         PROCESO DE CADA ESTADO
// ============================================================================

void procesarError(uint32_t ahora) {
  if ((int32_t)(ahora - errProx) < 0) return;
  if (iniciarHardware()) {
    irACalibrar();
  } else {
    errProx = millis() + REINTENTO_MS;
  }
}

void procesarCalibracion(uint32_t ahora) {
  if ((ahora - calInicio) > CAL_TIMEOUT_MS) {
    Serial.println(F("ERROR: tiempo agotado calibrando (lecturas del BMP280 invalidas)."));
    bmpOk = false;
    irAError();
    return;
  }
  if ((int32_t)(ahora - calProx) < 0) return;
  calProx = ahora + CAL_PERIODO_MS;
  float p, t;
  if (!leerSensor(p, t)) return;
  if (calN == 0) calRef = p;
  calSuma += (p - calRef);
  calN++;
  if (calN >= CAL_MUESTRAS) {
    p0 = calRef + calSuma / CAL_MUESTRAS;
    ultimaTemp = t;
    irAArmado();
  }
}

// Devuelve true si toca tomar una muestra ahora (y avanza la agenda).
bool tocaMuestrear(uint32_t ahora) {
  if ((int32_t)(ahora - proxMuestra) < 0) return false;
  proxMuestra += PERIODO_MS;
  // Si nos atrasamos mucho (ej. escritura lenta en SD), resincronizar
  if ((int32_t)(ahora - proxMuestra) > (int32_t)(4 * PERIODO_MS)) proxMuestra = ahora + PERIODO_MS;
  return true;
}

void procesarArmado(uint32_t ahora) {
  if (!tocaMuestrear(ahora)) return;
  float p, t;
  if (!leerSensor(p, t)) {
    // Si el sensor falla se reintenta en la proxima muestra
    return;
  }
  ultimaTemp = t;
  float alt = altitudRelativa(p);

  // Guardar en el buffer circular
  bufMs[bufIdx] = ahora;
  bufP[bufIdx] = p;
  bufIdx = (bufIdx + 1) % BUF_N;
  if (bufCuenta < BUF_N) bufCuenta++;

  // Deteccion de despegue
  if (alt > DESPEGUE_ALT_M) {
    if (seguidasAlto < 255) seguidasAlto++;
  } else {
    seguidasAlto = 0;
  }

  // Correccion lenta de p0 solo si estamos en el suelo
  if (seguidasAlto == 0 && fabs(alt) < DERIVA_VENTANA_M) {
    p0 += DERIVA_ALFA * (p - p0);
  }

  if (seguidasAlto >= DESPEGUE_MUESTRAS) {
    iniciarGrabacion();
  }
}

void falloGrabacion() {
  Serial.println(F("ERROR: falla de escritura en la SD durante el vuelo."));
  sdOk = false;
  irAError();   // cierra el archivo; la SD se reintenta cada 2 s
}

void procesarGrabacion(uint32_t ahora) {
  if (!tocaMuestrear(ahora)) return;
  float p, t;
  if (leerSensor(p, t)) {
    ultimaTemp = t;
    float alt = altitudRelativa(p);
    bool ok = escribirMuestra(ahora, alt, p, t);
    registrarMaximo(ahora, alt);
    relUltimaMs = (int32_t)(ahora - t0);
    if (!ok) { falloGrabacion(); return; }

    // Aterrizaje: dentro de la banda del suelo durante 5 s seguidos
    if (fabs(alt) <= ATERRIZAJE_BANDA_M) {
      if (!enBanda) { enBanda = true; bandaInicio = ahora; }
    } else {
      enBanda = false;
    }
  }
  if (estado != ESTADO_GRABANDO) return;   // leerSensor pudo pasar a ERROR

  if (enBanda && (ahora - bandaInicio) >= ATERRIZAJE_MS) {
    finalizarVuelo(false);
    return;
  }
  if ((ahora - t0) >= GRABACION_MAX_MS) {
    finalizarVuelo(true);
    return;
  }
  if ((ahora - ultimoFlush) >= FLUSH_PERIODO_MS) {
    archivo.flush();
    ultimoFlush = ahora;
    uint32_t tam = archivo.size();
    if (tam <= tamanoPrev) { falloGrabacion(); return; }   // el archivo no crece: la SD fallo
    tamanoPrev = tam;
  }
}

// ============================================================================
//                              SETUP / LOOP
// ============================================================================

void setup() {
  Serial.begin(SERIAL_BAUD);       // Solo para depurar; el equipo anda sin USB
#if USAR_INDICADOR
  pinMode(STATUS_PIN, OUTPUT);
  digitalWrite(STATUS_PIN, LOW);
#endif
  Serial.println(F("GCE Berisso - Computadora de vuelo"));

  if (iniciarHardware()) {
    irACalibrar();
  } else {
    estado = ESTADO_ERROR;
    errProx = millis() + REINTENTO_MS;
  }
}

void loop() {
  uint32_t ahora = millis();
  actualizarIndicador(ahora);

  switch (estado) {
    case ESTADO_ERROR:      procesarError(ahora);      break;
    case ESTADO_CALIBRANDO: procesarCalibracion(ahora); break;
    case ESTADO_ARMADO:     procesarArmado(ahora);     break;
    case ESTADO_GRABANDO:   procesarGrabacion(ahora);  break;
    case ESTADO_SENAL:
      if (avanzarSenal(ahora)) irACalibrar();
      break;
  }
}
