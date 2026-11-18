/* Parseo y estadísticas de vuelo. Usable en el navegador (window.GCEParser) y en Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCEParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MSG_SIN_DATOS = 'El archivo no tiene datos de altitud reconocibles';

  function num(s) {
    if (s === undefined || s === null) return NaN;
    s = String(s).trim();
    if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    return parseFloat(s);
  }

  function findCol(names, key, fallback) {
    for (var i = 0; i < names.length; i++) if (names[i].indexOf(key) === 0) return i;
    return fallback;
  }

  /** Parsea el texto de un vuelo. Lanza Error con mensaje en español si no hay datos. */
  function parseFlight(text, fileName) {
    text = String(text || '').replace(/^\uFEFF/, '');
    var lines = text.split(/\r\n|\r|\n/);
    // si el archivo no termina en salto de línea, la última línea de datos pudo cortarse (pérdida de energía)
    var truncatedLast = text.length > 0 && !/[\r\n]$/.test(text);
    var lastIdx = -1;
    for (var q = lines.length - 1; q >= 0; q--) { if (lines[q].trim()) { lastIdx = q; break; } }
    var meta = {};
    var cols = null;
    var rows = [];
    var ignored = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.charAt(0) !== '#' && truncatedLast && i === lastIdx) { ignored++; continue; }
      if (line.charAt(0) === '#') {
        var m = /^#\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
        if (m) {
          var key = m[1].toLowerCase();
          meta[key] = m[2].trim();
          if (key === 'columnas') {
            cols = m[2].split(/[,;\t]/).map(function (c) { return c.trim().toLowerCase(); });
          }
        }
        continue;
      }
      var parts;
      if (line.indexOf(';') >= 0 || line.indexOf('\t') >= 0) {
        parts = line.replace(/,/g, '.').split(/[;\t]/);
      } else {
        parts = line.split(',');
      }
      rows.push(parts);
    }

    var iT = 0, iA = 1, iP = 2, iC = 3;
    if (cols) {
      iT = findCol(cols, 'tiempo', 0);
      iA = findCol(cols, 'alt', 1);
      iP = findCol(cols, 'pres', 2);
      iC = findCol(cols, 'temp', 3);
    }

    // cantidad de campos esperada: la de "# columnas:" o, si no está, la más frecuente entre las filas
    var expected = 0;
    if (cols) expected = cols.length;
    else {
      var freq = {}, best = 0;
      rows.forEach(function (r) { freq[r.length] = (freq[r.length] || 0) + 1; });
      Object.keys(freq).forEach(function (k) { if (freq[k] > best) { best = freq[k]; expected = Number(k); } });
    }
    expected = Math.max(expected, 2);

    var t = [], alt = [], pres = [], temp = [];
    var hasP = false, hasC = false;
    rows.forEach(function (p) {
      if (p.length < expected) { ignored++; return; }
      var tv = num(p[iT]), av = num(p[iA]);
      if (!isFinite(tv) || !isFinite(av)) { ignored++; return; }
      var pv = num(p[iP]), cv = num(p[iC]);
      if (isFinite(pv)) hasP = true;
      if (isFinite(cv)) hasC = true;
      t.push(tv); alt.push(av);
      pres.push(isFinite(pv) ? pv : null);
      temp.push(isFinite(cv) ? cv : null);
    });

    if (t.length < 2) throw new Error(MSG_SIN_DATOS);

    // orden temporal (por si hubiera líneas desordenadas)
    var idx = t.map(function (_, k) { return k; });
    idx.sort(function (a, b) { return t[a] - t[b] || a - b; });
    var moved = idx.some(function (v, k) { return v !== k; });
    if (moved) {
      t = idx.map(function (k) { return t[k]; });
      alt = idx.map(function (k) { return alt[k]; });
      pres = idx.map(function (k) { return pres[k]; });
      temp = idx.map(function (k) { return temp[k]; });
    }

    var flight = {
      fileName: fileName || 'vuelo',
      meta: meta,
      t: t, alt: alt,
      pres: hasP ? pres : null,
      temp: hasC ? temp : null,
      ignoredLines: ignored
    };
    flight.stats = computeStats(t, alt);
    return flight;
  }

  /** Pendiente de regresión lineal de y sobre x en [a, b] (inclusive). */
  function slope(x, y, a, b) {
    var n = b - a + 1, sx = 0, sy = 0, i;
    for (i = a; i <= b; i++) { sx += x[i]; sy += y[i]; }
    var mx = sx / n, my = sy / n, nu = 0, den = 0;
    for (i = a; i <= b; i++) { nu += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) * (x[i] - mx); }
    return den > 0 ? nu / den : 0;
  }

  /** Estadísticas calculadas solo a partir de los datos (no del resumen del archivo). */
  function computeStats(t, alt) {
    var n = t.length, iMax = 0, i;
    for (i = 1; i < n; i++) if (alt[i] > alt[iMax]) iMax = i;
    var altMax = alt[iMax];

    // velocidad máxima de ascenso (estimada): pendiente en ventana de ±5 muestras, hasta el apogeo
    var vMax = null;
    for (i = 0; i <= iMax; i++) {
      var a = Math.max(0, i - 5), b = Math.min(iMax, i + 5);
      if (b - a < 2) continue;
      var s = slope(t, alt, a, b);
      if (vMax === null || s > vMax) vMax = s;
    }

    // velocidad de descenso promedio: desde (apogeo - 10%) hasta 10 m de altura
    var vDesc = null;
    var hStart = altMax * 0.9, hEnd = 10;
    if (altMax > hEnd * 1.5) {
      var i0 = -1, i1 = -1;
      for (i = iMax; i < n; i++) { if (alt[i] <= hStart) { i0 = i; break; } }
      if (i0 >= 0) for (i = i0; i < n; i++) { if (alt[i] <= hEnd) { i1 = i; break; } }
      if (i0 >= 0 && i1 - i0 >= 3 && t[i1] > t[i0]) {
        vDesc = (alt[i0] - alt[i1]) / (t[i1] - t[i0]);
      }
    }

    // el tiempo se mide desde el despegue (t = 0) si hay muestras previas
    var tStart = t[0] < 0 ? 0 : t[0];
    return {
      altMax: altMax,
      tApogeo: t[iMax],
      iApogeo: iMax,
      vAscMax: vMax,
      vDescProm: vDesc,
      duracion: t[n - 1] - tStart,
      muestras: n
    };
  }

  return { parseFlight: parseFlight, computeStats: computeStats, MSG_SIN_DATOS: MSG_SIN_DATOS };
});
