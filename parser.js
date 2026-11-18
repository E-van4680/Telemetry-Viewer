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
    flight.deriv = computeDerivatives(t, alt);
    flight.stats = computeStats(t, alt, flight.deriv);
    return flight;
  }

  /* ---------- derivadas numéricas (velocidad y aceleración verticales) ---------- */

  var SIGMA_MIN = 0.05; // m, piso del ruido de altitud

  /** Ajuste lineal de y sobre x en [a, b]. Devuelve {n, mx, my, sxx, m, ss} (ss = suma de residuos al cuadrado). */
  function linFit(x, y, a, b) {
    var n = b - a + 1, sx = 0, sy = 0, i;
    for (i = a; i <= b; i++) { sx += x[i]; sy += y[i]; }
    var mx = sx / n, my = sy / n, sxy = 0, sxx = 0;
    for (i = a; i <= b; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); }
    var m = sxx > 0 ? sxy / sxx : 0, ss = 0;
    for (i = a; i <= b; i++) { var r = y[i] - my - m * (x[i] - mx); ss += r * r; }
    return { n: n, mx: mx, my: my, sxx: sxx, m: m, ss: ss };
  }

  /** Inversa de una matriz m x m (Gauss-Jordan con pivoteo parcial). null si es singular. */
  function invert(A) {
    var m = A.length, M = [], i, j, k;
    for (i = 0; i < m; i++) {
      M.push(A[i].slice());
      for (j = 0; j < m; j++) M[i].push(i === j ? 1 : 0);
    }
    for (i = 0; i < m; i++) {
      var p = i;
      for (k = i + 1; k < m; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[p]; M[p] = tmp;
      var d = M[i][i];
      for (j = 0; j < 2 * m; j++) M[i][j] /= d;
      for (k = 0; k < m; k++) {
        if (k === i) continue;
        var f = M[k][i];
        if (f !== 0) for (j = 0; j < 2 * m; j++) M[k][j] -= f * M[i][j];
      }
    }
    return M.map(function (row) { return row.slice(m); });
  }

  /**
   * Ajuste polinomial local por mínimos cuadrados en [a, b], centrado en t0 y normalizado
   * (u = (t - t0) / s) para que el sistema esté bien condicionado.
   * Devuelve {c (coef. en u), inv ((XᵀX)⁻¹ en u), s} o null.
   */
  function polyFit(t, y, a, b, t0, deg) {
    var m = deg + 1, s = 0, j, r, c;
    for (j = a; j <= b; j++) s = Math.max(s, Math.abs(t[j] - t0));
    if (!(s > 0) || b - a + 1 < m) return null;
    var A = [], rhs = [];
    for (r = 0; r < m; r++) { A.push(new Array(m).fill(0)); rhs.push(0); }
    for (j = a; j <= b; j++) {
      var u = (t[j] - t0) / s, pw = [1];
      for (r = 1; r < 2 * m - 1; r++) pw.push(pw[r - 1] * u);
      for (r = 0; r < m; r++) {
        rhs[r] += pw[r] * y[j];
        for (c = 0; c < m; c++) A[r][c] += pw[r + c];
      }
    }
    var inv = invert(A);
    if (!inv) return null;
    var coef = [];
    for (r = 0; r < m; r++) {
      var v = 0;
      for (c = 0; c < m; c++) v += inv[r][c] * rhs[c];
      coef.push(v);
    }
    return { c: coef, inv: inv, s: s };
  }

  /** Ruido de la altitud (σ_h) estimado de los datos. Devuelve {sigma, fuente}. */
  function estimateSigma(t, alt) {
    var n = t.length, i, ss = 0, dof = 0, fuentes = [], segs = [];

    // tramo quieto previo al despegue
    var pre = 0;
    while (pre < n && t[pre] < -0.5) pre++;
    if (pre >= 10) {
      var f1 = linFit(t, alt, 0, pre - 1);
      ss += f1.ss; dof += f1.n - 2; fuentes.push('reposo previo al despegue'); segs.push([0, pre - 1]);
    }

    // tramo final en el suelo: últimos ~4 s, altitud cerca de 0 y estable
    var i0 = n - 1;
    while (i0 > 0 && t[i0 - 1] >= t[n - 1] - 4) i0--;
    if (n - i0 >= 10 && i0 > pre) {
      var f2 = linFit(t, alt, i0, n - 1), lo = Infinity, hi = -Infinity;
      for (i = i0; i < n; i++) { lo = Math.min(lo, alt[i]); hi = Math.max(hi, alt[i]); }
      var sd = Math.sqrt(f2.ss / (f2.n - 2));
      if (Math.abs(f2.my) < 3 && hi - lo < 6 && sd < 1.5) {
        ss += f2.ss; dof += f2.n - 2; fuentes.push('reposo final en el suelo'); segs.push([i0, n - 1]);
      }
    }

    var sigma, fuente, piso = false;
    if (dof > 0) {
      sigma = Math.sqrt(ss / dof);
      fuente = fuentes.join(' + ');
    } else {
      // sin tramo quieto: residuos de un ajuste cuadrático local (±5) con corrección por grados de libertad
      var K = 5, sum = 0, den = 0;
      for (i = K; i < n - K; i++) {
        var fit = polyFit(t, alt, i - K, i + K, t[i], 2);
        if (!fit) continue;
        var r = alt[i] - fit.c[0];
        sum += r * r; den += 1 - fit.inv[0][0];
      }
      if (den > 0) { sigma = Math.sqrt(sum / den); fuente = 'serie completa (ajuste cuadrático local)'; }
      else { sigma = SIGMA_MIN; fuente = 'valor mínimo (pocos datos)'; piso = true; }
    }
    if (!(sigma >= SIGMA_MIN)) { sigma = SIGMA_MIN; piso = true; fuente += ' (piso de ' + SIGMA_MIN + ' m)'; }
    return { sigma: sigma, fuente: fuente, piso: piso, segs: segs };
  }

  /**
   * Velocidad y aceleración verticales estimadas a partir de la altitud (barométrica).
   * v: pendiente de una regresión lineal local (±kv muestras); a: 2·a2 de un ajuste cuadrático local (±ka).
   * Errores sv, sa: 1σ aleatorios (no incluyen el sesgo por suavizado ni el retardo del sensor).
   * opts: {kv, ka, sigmaH}. Los bordes sin puntos suficientes (<3 para v, <5 para a) quedan en null.
   */
  function computeDerivatives(t, alt, opts) {
    opts = opts || {};
    var kv = opts.kv > 0 ? opts.kv : 5, ka = opts.ka > 0 ? opts.ka : 10;
    var n = t.length, v = new Array(n), a = new Array(n), sv = new Array(n), sa = new Array(n);
    var est;
    if (opts.sigmaH > 0) est = { sigma: Math.max(opts.sigmaH, SIGMA_MIN), fuente: 'valor indicado' };
    else est = estimateSigma(t, alt);
    est.segs = est.segs || [];
    var sig = est.sigma, i;
    var dts = [];
    for (i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
    dts.sort(function (x, y) { return x - y; });
    var dtMed = dts.length ? dts[Math.floor(dts.length / 2)] : 0;

    for (i = 0; i < n; i++) {
      v[i] = a[i] = sv[i] = sa[i] = null;
      var lo = Math.max(0, i - kv), hi = Math.min(n - 1, i + kv);
      if (hi - lo + 1 >= 3) {
        var f = linFit(t, alt, lo, hi);
        // sesgo de la pendiente respecto de v(t_i) en una parábola: a·[(t̄ − t_i) + Σ(t − t̄)³/(2Σ(t − t̄)²)]
        var m3 = 0;
        for (var jj = lo; jj <= hi; jj++) m3 += Math.pow(t[jj] - f.mx, 3);
        var desv = (f.mx - t[i]) + (f.sxx > 0 ? m3 / (2 * f.sxx) : 0);
        if (Math.abs(desv) > 0.25 * dtMed) {
          // ventana asimétrica o irregular (bordes, muestras faltantes): la pendiente no vale en t_i -> derivada del cuadrático en t_i
          var qv = polyFit(t, alt, lo, hi, t[i], 2);
          if (qv) { v[i] = qv.c[1] / qv.s; sv[i] = sig * Math.sqrt(qv.inv[1][1]) / qv.s; }
        } else if (f.sxx > 0) { v[i] = f.m; sv[i] = sig / Math.sqrt(f.sxx); }
      }
      lo = Math.max(0, i - ka); hi = Math.min(n - 1, i + ka);
      if (hi - lo + 1 >= 5) {
        var q = polyFit(t, alt, lo, hi, t[i], 2);
        if (q) {
          a[i] = 2 * q.c[2] / (q.s * q.s);
          sa[i] = 2 * sig * Math.sqrt(q.inv[2][2]) / (q.s * q.s);
        }
      }
    }

    // error empírico: en los tramos quietos v y a reales son 0, así que el RMS de lo estimado mide el error real
    // (incluye la autocorrelación del ruido que deja el filtro IIR del sensor). Solo ventanas completas dentro del tramo.
    var vv = [], aa = [];
    est.segs.forEach(function (sg) {
      for (var j = sg[0]; j <= sg[1]; j++) {
        if (j - kv >= sg[0] && j + kv <= sg[1] && v[j] !== null) vv.push(v[j]);
        if (j - ka >= sg[0] && j + ka <= sg[1] && a[j] !== null) aa.push(a[j]);
      }
    });
    var rms = function (x) { var q = 0; x.forEach(function (y) { q += y * y; }); return Math.sqrt(q / x.length); };
    var svEmp = vv.length >= 5 ? rms(vv) : null, saEmp = aa.length >= 5 ? rms(aa) : null;
    var usoEmp = false;
    for (i = 0; i < n; i++) {
      if (sv[i] !== null && svEmp !== null && svEmp > sv[i]) { sv[i] = svEmp; usoEmp = true; }
      if (sa[i] !== null && saEmp !== null && saEmp > sa[i]) { sa[i] = saEmp; usoEmp = true; }
    }
    var fuenteError = usoEmp ? 'empírico (medido en el reposo)' : (svEmp !== null || saEmp !== null ? 'teórico (el empírico no lo superó)' : 'teórico (sin tramo quieto suficiente)');
    return { v: v, a: a, sv: sv, sa: sa, sigmaH: sig, kv: kv, ka: ka, fuenteSigma: est.fuente, sigmaPiso: !!est.piso,
      svEmp: svEmp, saEmp: saEmp, fuenteError: fuenteError };
  }

  /** Estadísticas calculadas solo a partir de los datos (no del resumen del archivo). */
  function computeStats(t, alt, deriv) {
    var n = t.length, iMax = 0, i;
    for (i = 1; i < n; i++) if (alt[i] > alt[iMax]) iMax = i;
    var altMax = alt[iMax];
    deriv = deriv || computeDerivatives(t, alt);

    // velocidad máxima de ascenso y aceleración máxima (estimadas), hasta el apogeo; mismo cálculo que los gráficos
    var vMax = null, svMax = null, aMax = null, saMax = null;
    for (i = 0; i <= iMax; i++) {
      if (deriv.v[i] !== null && (vMax === null || deriv.v[i] > vMax)) { vMax = deriv.v[i]; svMax = deriv.sv[i]; }
      if (deriv.a[i] !== null && (aMax === null || deriv.a[i] > aMax)) { aMax = deriv.a[i]; saMax = deriv.sa[i]; }
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
      vAscMaxErr: svMax === null ? null : 2 * svMax,
      aMax: aMax,
      aMaxErr: saMax === null ? null : 2 * saMax,
      vDescProm: vDesc,
      duracion: t[n - 1] - tStart,
      muestras: n
    };
  }

  return { parseFlight: parseFlight, computeStats: computeStats, computeDerivatives: computeDerivatives, MSG_SIN_DATOS: MSG_SIN_DATOS };
});
