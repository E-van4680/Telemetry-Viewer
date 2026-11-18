# Computadora de vuelo - GCE Berisso

Firmware para el Arduino Nano que registra la altitud de un cohete en una
tarjeta microSD. Los archivos `VUELOnnn.TXT` se cargan después en el visor web.

Sketch: `ComputadoraVuelo/ComputadoraVuelo.ino` (todo en un solo archivo; los
pines, la frecuencia y los umbrales están en el bloque de configuración al
principio).

## Conexiones

| Módulo            | Pin del módulo | Pin del Nano | Nota                          |
|-------------------|----------------|--------------|-------------------------------|
| BMP280            | VCC            | 3V3 (o 5V según el módulo) | Mirar qué tolera tu placa |
| BMP280            | GND            | GND          |                               |
| BMP280            | SDA            | A4           | I2C, dirección 0x76 o 0x77    |
| BMP280            | SCL            | A5           |                               |
| MicroSD (SPI)     | VCC            | 5V           | Módulo con regulador/level shifter |
| MicroSD (SPI)     | GND            | GND          |                               |
| MicroSD (SPI)     | MOSI           | D11          |                               |
| MicroSD (SPI)     | MISO           | D12          |                               |
| MicroSD (SPI)     | SCK            | D13          | Por eso NO se usa el LED de la placa |
| MicroSD (SPI)     | CS             | D4           |                               |
| LED / buzzer      | (+)            | D5           | `STATUS_PIN`. LED con resistencia de ~330 Ω, o buzzer activo |
| LED / buzzer      | (-)            | GND          |                               |
| Batería 9V        | (+)            | VIN          | (-) a GND                     |

Para desactivar el LED/buzzer poné `#define USAR_INDICADOR 0` en el sketch.

## Librerías

- Adafruit BMP280 Library (con Adafruit BusIO y Adafruit Unified Sensor)
- SD (incluida con el IDE de Arduino)
- Wire y SPI (incluidas)

## Cómo subirlo

1. Abrir `ComputadoraVuelo/ComputadoraVuelo.ino` en el Arduino IDE.
2. Herramientas > Placa > Arduino Nano.
3. Herramientas > Procesador > ATmega328P.
4. Elegir el puerto y apretar Subir.
5. Si la carga falla (`stk500_getsync()`), cambiar el procesador a
   **ATmega328P (Old Bootloader)** y volver a subir. Muchos Nano clones usan
   el bootloader viejo.

El Monitor Serie (115200 baud) sirve solo para depurar. El equipo funciona sin
la PC conectada.

## Uso en el taller

1. Poner la tarjeta microSD en el módulo y conectar la batería de 9V **en la
   rampa**, con el cohete ya parado y quieto.
2. Esperar la calibración (unos 2 s) hasta que el LED dé **un pulso corto cada
   2 segundos**. Eso significa "armado". No muevas ni toques el cohete mientras
   calibra.
3. Lanzar. Al superar 4 m de altura el LED queda **fijo** (grabando). El
   archivo incluye 1,5 s antes del despegue.
4. Recuperar el cohete. Al aterrizar (5 s seguidos a ±3 m del suelo) o a los 5
   minutos de grabación, el equipo guarda el vuelo y el LED/buzzer hace tantos
   pitidos como el número de vuelo. Después vuelve a calibrar y a armar solo,
   listo para el próximo vuelo (con o sin apagar entre vuelos).
5. Apagar, sacar la microSD y copiar el archivo `VUELOnnn.TXT` a la
   computadora.
6. Cargar el `.txt` en el visor web.

Si en la recuperación llevás el cohete a la rampa con una diferencia de altura
de más de 1 m respecto de donde se calibró (por ejemplo, el campo de aterrizaje
es más bajo que la rampa), **apagá y volvé a encender en la rampa** para que
calibre de nuevo. La corrección automática de deriva solo actúa cerca del
suelo (±1 m).

## Patrones del LED / buzzer

| Patrón                                   | Significado                              |
|------------------------------------------|------------------------------------------|
| Parpadeo rápido continuo                 | Error (falta BMP280/BME280, SD ausente, que no escribe o llena, o sensor sin respuesta). Reintenta cada 2 s |
| Apagado unos 2 s                         | Calibrando                               |
| Un pulso corto cada 2 s                  | Armado en la rampa                       |
| Encendido fijo                           | Grabando el vuelo                        |
| N pitidos (N = número de vuelo)          | Vuelo guardado; después calibra y arma   |

Durante cada reintento (cada 2 s) el equipo intenta reiniciar el sensor y la
SD, y eso puede tardar hasta unos 2 s: en ese lapso el LED puede quedar
congelado, fijo encendido o apagado, y después sigue el parpadeo rápido. Si el
reintento sale bien, pasa solo a calibrar y armar.

Los pitidos se limitan a 20 (`IND_PITIDOS_MAX`) para que no tarde minutos si
el vuelo es el número 300. El número real queda en el encabezado del archivo.

## Formato del archivo

Texto plano, una muestra por línea a 20 Hz. Las líneas que empiezan con `#`
son comentarios (encabezado y resumen).

```
# GCE Berisso - Computadora de vuelo
# vuelo: 3
# presion_suelo_Pa: 101325.0
# frecuencia_Hz: 20
# columnas: tiempo_s,altitud_m,presion_Pa,temperatura_C
-1.450,0.12,101323.6,22.4
...
0.000,4.31,101273.1,22.4
...
# altitud_max_m: 152.34
# tiempo_apogeo_s: 6.250
# duracion_s: 48.100
```

El tiempo 0 es el instante en que se detecta el despegue; las muestras
previas tienen tiempo negativo. La altitud es relativa al suelo calibrado. Las
muestras
previas al despegue usan la última temperatura leída antes del despegue (no se
guarda la temperatura de cada una). Su altitud se calcula con la presión del
suelo final del encabezado.
El filtro interno del sensor (IIR) retrasa un poco la señal, así que el apogeo
medido aparece unas décimas de segundo después del real.

Si se corta la batería durante el vuelo, el archivo queda sin las líneas de
resumen y se pierde como máximo 1 s de datos.

## Consejos

- Usar una microSD formateada en **FAT32** de **32 GB o menos**.
- Si hubo un corte de energía mientras se grababa, conviene reformatear la
  microSD (FAT32) después de copiar los datos, para evitar un sistema de
  archivos dañado.
- El equipo acepta tanto BMP280 como BME280 (ambos en 0x76 o 0x77); del BME280
  solo se usan presión y temperatura.
- Al armar, el equipo escribe y borra un archivo `PRUEBA.TMP` para comprobar
  que la tarjeta responde.
- Tapar el BMP280 con un trocito de espuma: el viento directo y la luz del sol
  alteran la presión medida.
- Hacer agujeros de ventilación en el fuselaje, cerca del sensor, para que la
  presión interna siga a la del aire (3 o 4 agujeros de 3 a 5 mm, sin que
  quede una sola abertura apuntando hacia adelante).
- Probar el equipo en tierra antes de volar: mirar el Monitor Serie, ver que
  arme y mover el sensor hacia arriba unos metros para comprobar que se crea el
  archivo.
- Si el Monitor Serie dice que no encuentra el sensor y los cables están
  bien, puede ser un clon con otro identificador de chip.
- Si el vuelo se detecta sin lanzar (golpes bruscos o viento fuerte en el
  sensor), se crea un archivo de poca duración; se puede borrar sin problemas.
