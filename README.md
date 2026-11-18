# Visor de telemetría · GCE Berisso

Sitio estático (sin paso de build) para ver los vuelos registrados por la computadora de vuelo del taller de cohetería GCE Berisso. Se publica tal cual en Vercel: la raíz del sitio es esta carpeta.

Todo se procesa en el navegador; los archivos de vuelo no se suben a ningún lado.

## Cómo se usa

1. Abrí la web y arrastrá y soltá uno o varios archivos `.txt` / `.csv` de vuelo (o usá el botón **Elegir archivos**). Sin archivos a mano, probá el link **Probar con un vuelo de ejemplo**.
2. Cada vuelo aparece como una tarjeta con la **altura máxima**, el tiempo hasta el apogeo, la velocidad máxima de ascenso (estimada), la velocidad de descenso promedio, la duración y el nombre del archivo.
3. Hacé clic en una tarjeta para ver ese vuelo, o activá **Superponer todos los vuelos** para compararlos.
4. Podés ponerle un nombre de cohete o alumno a cada vuelo (se usa en la leyenda y en las descargas), quitar vuelos o **Limpiar todo**.
5. **Descargar gráfico (PNG)** y **Descargar CSV** exportan lo que se está mostrando.

Todos los valores se calculan a partir de los datos, no de las líneas de resumen del archivo.

## Formato del archivo

```
# GCE Berisso - Computadora de vuelo
# vuelo: 3
# presion_suelo_Pa: 101325.0
# frecuencia_Hz: 20
# columnas: tiempo_s,altitud_m,presion_Pa,temperatura_C
-1.500,0.12,101323.6,22.4
0.000,4.31,101273.1,22.4
...
# altitud_max_m: 152.34
# tiempo_apogeo_s: 6.250
# duracion_s: 48.100
```

- Las líneas que empiezan con `#` son metadatos `clave: valor`.
- Las líneas de datos van separadas por comas (también se aceptan `;` y tabulaciones, y finales de línea CRLF). Las líneas mal formadas se ignoran.
- Las líneas de resumen del final son opcionales (pueden faltar si el vuelo terminó por un corte de batería).
- Se acepta un archivo con solo 2 columnas (tiempo, altitud).

## Cálculos

- **Altura máxima / apogeo**: máximo de la altitud medida.
- **Velocidad máxima de ascenso y aceleración máxima (estimadas)**: máximos hasta el apogeo de las curvas de velocidad y aceleración (ver abajo), con su ±error (2σ).
- **Velocidad de descenso promedio**: desde el primer punto posterior al apogeo con altitud menor o igual al 90 % del máximo hasta el primero que baja de 10 m.
- **Duración**: desde el despegue (t = 0, o la primera muestra si no hay datos previos) hasta la última muestra.

## Velocidad y aceleración (estimadas)

Debajo del gráfico de altitud hay una sección plegable (cerrada por defecto) con la velocidad y la aceleración verticales en función del tiempo. Los gráficos se crean recién al abrirla. Se calculan en `computeDerivatives(t, alt, opts)` de `parser.js`:

1. **Ruido de la altitud (σ_h)**: desvío estándar de los residuos de un ajuste lineal en el tramo quieto previo al despegue (t < -0,5 s, si hay al menos 10 muestras) y/o en los últimos ~4 s si el cohete está en el suelo (altitud cerca de 0 y estable). Si no hay tramo quieto, se estima con toda la serie (residuos de un ajuste cuadrático local de ±5 muestras, con corrección por grados de libertad). Piso de 0,05 m.
2. **Velocidad**: pendiente de una regresión lineal local por mínimos cuadrados en ±5 muestras (≈ ±0,25 s a 20 Hz), usando el tiempo real de cada muestra. Error 1σ: σ_h / sqrt(Σ(t − t̄)²).
3. **Aceleración**: 2·a2 de un ajuste cuadrático local en ±10 muestras (≈ ±0,5 s). Error 1σ: 2·σ_h·sqrt((XᵀX)⁻¹[2][2]).
4. **Error empírico**: el filtro IIR del BMP280 vuelve al ruido autocorrelacionado, así que las fórmulas teóricas subestiman el error. En los tramos quietos (antes del despegue y final en el suelo) la velocidad y la aceleración reales son 0: se aplica el mismo estimador a esos puntos (solo ventanas completas dentro del tramo, mínimo 5 valores) y el RMS da σ_v y σ_a empíricos. El error usado en cada punto es el mayor entre el teórico y el empírico, y la web indica cuál se aplicó. Si σ de la altitud queda en el piso de 0,05 m, se muestra una nota.
5. En los bordes la ventana se recorta; con menos de 3 puntos (velocidad) o 5 (aceleración) el valor queda vacío.

Los errores que se muestran son 2σ (~95 %) y **solo aleatorios** (ruido del sensor). No incluyen los errores sistemáticos: el sesgo por suavizado de la ventana en los cambios bruscos (encendido del motor, eyección quedan suavizados) y el retardo del filtro IIR del BMP280. El checkbox *Mostrar curvas máxima y mínima* agrega la estimación ±2σ como curvas punteadas y banda sombreada. El CSV incluye las columnas `velocidad_ms`, `acel_ms2`, `err_vel` y `err_acel` (errores 2σ).

## Archivos

- `index.html`, `styles.css`, `app.js`: la interfaz.
- `parser.js`: parseo y estadísticas (se usa en el navegador y también desde Node).
- `ejemplo/`: dos vuelos sintéticos de prueba.
- `firmware/`: código de la computadora de vuelo. Ver [firmware/README.md](firmware/README.md).

## Probar en local

```
python -m http.server 8123
```

Y abrí http://localhost:8123. El gráfico usa Chart.js 4.4.1 desde cdnjs, así que hace falta conexión a internet.
