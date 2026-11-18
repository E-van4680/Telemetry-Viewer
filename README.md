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
- **Velocidad máxima de ascenso (estimada)**: pendiente de una regresión lineal sobre una ventana de ±5 muestras, hasta el apogeo.
- **Velocidad de descenso promedio**: desde el primer punto posterior al apogeo con altitud menor o igual al 90 % del máximo hasta el primero que baja de 10 m.
- **Duración**: desde el despegue (t = 0, o la primera muestra si no hay datos previos) hasta la última muestra.

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
