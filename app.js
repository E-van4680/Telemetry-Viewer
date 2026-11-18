/* Visor de telemetría GCE Berisso. Todo corre en el navegador. */
(function () {
  'use strict';

  var PALETA = ['#5BA6DE', '#FDB71C', '#E4572E', '#2E9E6B', '#8E5BD6', '#D6409F', '#1B4F8A', '#8C6A3F', '#0E9AA7', '#6B7280'];
  var EJEMPLOS = ['ejemplo/VUELO001.TXT', 'ejemplo/VUELO002.TXT'];

  var flights = [];      // {id, fileName, label, color, data}
  var selectedId = null;
  var nextId = 1;
  var chart = null, chartV = null, chartA = null;

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('dropzone'), fileInput = $('file-input'), errores = $('errores');
  var panel = $('panel'), cardsEl = $('cards'), chkSuperponer = $('chk-superponer');
  var detDeriv = $('det-deriv'), chkBandas = $('chk-bandas');

  /* ---------- utilidades ---------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmt(v, d, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return v.toFixed(d).replace('.', ',') + (unit ? ' ' + unit : '');
  }
  function nombre(f) { return f.label.trim() || f.fileName; }
  function colorLibre() {
    var usados = flights.map(function (f) { return f.color; });
    for (var i = 0; i < PALETA.length; i++) if (usados.indexOf(PALETA[i]) < 0) return PALETA[i];
    return PALETA[flights.length % PALETA.length];
  }
  function showError(msg) {
    var d = el('div', 'error');
    d.appendChild(el('strong', null, 'Error: '));
    d.appendChild(document.createTextNode(msg));
    errores.appendChild(d);
  }
  function showNotice(msg) {
    var d = el('div', 'aviso');
    d.appendChild(el('strong', null, 'Aviso: '));
    d.appendChild(document.createTextNode(msg));
    errores.appendChild(d);
  }
  function clearErrors() { errores.textContent = ''; }
  function slug(s) {
    return (s || 'vuelo').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'vuelo';
  }
  function download(blob, fileName) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  /* ---------- carga de archivos ---------- */
  function addFromText(text, fileName) {
    try {
      var key = fileName + '|' + text.length + '|' + hash(text);
      if (flights.some(function (x) { return x.key === key; })) {
        showNotice(fileName + ' ya estaba cargado (mismo nombre y mismo contenido); se omitió el duplicado.');
        return false;
      }
      var data = GCEParser.parseFlight(text, fileName);
      var f = { id: nextId++, key: key, fileName: fileName, label: '', color: colorLibre(), data: data };
      flights.push(f);
      selectedId = f.id;
      return true;
    } catch (e) {
      showError(fileName + ': ' + (e && e.message ? e.message : 'no se pudo leer el archivo.'));
      return false;
    }
  }

  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    clearErrors();
    Promise.all(files.map(function (file) {
      return file.text().then(function (t) { return { name: file.name, text: t }; },
        function () { showError(file.name + ': no se pudo leer el archivo.'); return null; });
    })).then(function (items) {
      items.forEach(function (it) { if (it) addFromText(it.text, it.name); });
      render(true);
    });
  }

  function loadExamples(ev) {
    ev.preventDefault();
    clearErrors();
    Promise.all(EJEMPLOS.map(function (url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (t) { return { name: url.split('/').pop(), text: t }; });
    })).then(function (items) {
      items.forEach(function (it) { addFromText(it.text, it.name); });
      render(true);
    }).catch(function () {
      showError('No se pudieron cargar los vuelos de ejemplo. Abrí el sitio desde un servidor web (no desde un archivo local).');
    });
  }

  /* ---------- gráfico ---------- */
  function apogeoPlugin() {
    return {
      id: 'etiquetaApogeo',
      afterDatasetsDraw: function (c) {
        var ctx = c.ctx, area = c.chartArea;
        var big = c.width > 700;
        c.data.datasets.forEach(function (ds, i) {
          if (!ds.esApogeo || !c.isDatasetVisible(i)) return;
          var pt = c.getDatasetMeta(i).data[0];
          if (!pt) return;
          var txt = 'Apogeo ' + fmt(ds.data[0].y, 1, 'm');
          ctx.save();
          ctx.font = '700 ' + (big ? 14 : 12) + 'px system-ui, sans-serif';
          var w = ctx.measureText(txt).width;
          var x = Math.min(Math.max(pt.x - w / 2, area.left + 4), area.right - w - 4);
          var y = pt.y - 16;
          if (y < area.top + 12) y = pt.y + 26;
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 4;
          ctx.strokeStyle = c.options.temaFondo;
          ctx.strokeText(txt, x, y);
          ctx.fillStyle = c.options.temaTexto;
          ctx.fillText(txt, x, y);
          ctx.restore();
        });
      }
    };
  }

  function visibles() {
    if (chkSuperponer.checked) return flights;
    return flights.filter(function (f) { return f.id === selectedId; });
  }

  function buildDatasets(list) {
    var ds = [];
    list.forEach(function (f) {
      var d = f.data, pts = new Array(d.t.length);
      for (var i = 0; i < d.t.length; i++) pts[i] = { x: d.t[i], y: d.alt[i] };
      ds.push({
        label: nombre(f), data: pts, borderColor: f.color, backgroundColor: f.color,
        borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: 0, parsing: false, order: 2
      });
      ds.push({
        label: nombre(f) + ' (apogeo)', esApogeo: true,
        data: [{ x: d.stats.tApogeo, y: d.stats.altMax }],
        borderColor: f.color, backgroundColor: f.color, pointStyle: 'circle',
        pointRadius: 8, pointHoverRadius: 10, pointBorderWidth: 3, pointBorderColor: '#ffffff',
        showLine: false, parsing: false, order: 1
      });
    });
    return ds;
  }

  function rangoX(list) {
    var lo = Infinity, hi = -Infinity;
    list.forEach(function (f) {
      lo = Math.min(lo, f.data.t[0]); hi = Math.max(hi, f.data.t[f.data.t.length - 1]);
    });
    return { min: lo, max: hi };
  }

  function chartConfig(list, tema, fixedSize) {
    var rx = rangoX(list);
    return {
      type: 'line',
      data: { datasets: buildDatasets(list) },
      plugins: [apogeoPlugin()],
      options: {
        temaTexto: tema.texto, temaFondo: tema.fondo,
        responsive: !fixedSize, maintainAspectRatio: false, animation: false, normalized: true,
        devicePixelRatio: fixedSize ? 1 : undefined,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear', min: rx.min, max: rx.max,
            title: { display: true, text: 'Tiempo (s)', color: tema.texto, font: { size: 14, weight: '600' } },
            ticks: { color: tema.texto, font: { size: 13 }, includeBounds: false }, grid: { color: tema.grilla }
          },
          y: {
            title: { display: true, text: 'Altitud (m)', color: tema.texto, font: { size: 14, weight: '600' } },
            ticks: { color: tema.texto, font: { size: 13 } }, grid: { color: tema.grilla }
          }
        },
        plugins: {
          legend: {
            display: list.length > 1 || fixedSize,
            labels: {
              color: tema.texto, font: { size: 14 }, usePointStyle: true, boxWidth: 10,
              filter: function (item, data) { return !data.datasets[item.datasetIndex].esApogeo; }
            }
          },
          tooltip: {
            callbacks: {
              title: function (items) { return 't = ' + fmt(items[0].parsed.x, 2, 's'); },
              label: function (ctx) { return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 1, 'm'); }
            }
          }
        }
      }
    };
  }

  function temaPantalla() {
    var cs = getComputedStyle(document.documentElement);
    return {
      texto: cs.getPropertyValue('--text').trim() || '#14212e',
      grilla: cs.getPropertyValue('--border').trim() || '#cfdceb',
      fondo: cs.getPropertyValue('--surface').trim() || '#ffffff'
    };
  }

  function drawChart() {
    var err = $('chart-error');
    if (typeof Chart === 'undefined') {
      err.hidden = false;
      err.textContent = 'No se pudo cargar la librería de gráficos (Chart.js). Revisá tu conexión a internet y recargá la página.';
      return;
    }
    err.hidden = true;
    if (chart) { chart.destroy(); chart = null; }
    var list = visibles();
    if (list.length) chart = new Chart($('grafico'), chartConfig(list, temaPantalla(), false));
    drawDeriv();
  }

  /* ---------- velocidad y aceleración (se crean solo con la sección abierta) ---------- */
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function derivDatasets(list, key, ekey) {
    var ds = [], bandas = chkBandas.checked;
    list.forEach(function (f) {
      var d = f.data, dv = d.deriv, main = [], up = [], lo = [];
      for (var i = 0; i < d.t.length; i++) {
        var y = dv[key][i];
        if (y === null) continue;
        var e = 2 * dv[ekey][i];
        main.push({ x: d.t[i], y: y, e: e });
        if (bandas) { up.push({ x: d.t[i], y: y + e, e: e }); lo.push({ x: d.t[i], y: y - e, e: e }); }
      }
      ds.push({
        fid: f.id, label: nombre(f), data: main, borderColor: f.color, backgroundColor: f.color,
        borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: 0, parsing: false, order: 1
      });
      if (bandas) {
        var base = { fid: f.id, esBanda: true, borderColor: rgba(f.color, 0.65), borderWidth: 1, borderDash: [3, 3],
          pointRadius: 0, pointHoverRadius: 0, tension: 0, parsing: false, order: 2 };
        ds.push(Object.assign({}, base, { data: up, label: nombre(f) + ' (+2σ)', fill: '+1', backgroundColor: rgba(f.color, 0.16) }));
        ds.push(Object.assign({}, base, { data: lo, label: nombre(f) + ' (−2σ)', fill: false, backgroundColor: rgba(f.color, 0.16) }));
      }
    });
    return ds;
  }

  function derivConfig(list, tema, key, ekey, ytitle, unit, rx) {
    var axis = function (title) {
      return { title: { display: true, text: title, color: tema.texto, font: { size: 14, weight: '600' } },
        ticks: { color: tema.texto, font: { size: 13 } }, grid: { color: tema.grilla } };
    };
    var xs = axis('Tiempo (s)'); xs.type = 'linear'; xs.min = rx.min; xs.max = rx.max;
    return {
      type: 'line',
      data: { datasets: derivDatasets(list, key, ekey) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: { x: xs, y: axis(ytitle) },
        plugins: {
          legend: {
            display: list.length > 1,
            labels: { color: tema.texto, font: { size: 14 }, usePointStyle: true, boxWidth: 10,
              filter: function (item, data) { return !data.datasets[item.datasetIndex].esBanda; } }
          },
          tooltip: {
            filter: function (item) { return !item.dataset.esBanda; },
            callbacks: {
              title: function (items) { return 't = ' + fmt(items[0].parsed.x, 2, 's'); },
              label: function (ctx) {
                return ctx.dataset.label + ': ' + fmt(ctx.parsed.y, 1, unit) + ' ± ' + fmt(ctx.raw.e, 1) + ' (2σ)';
              }
            }
          }
        }
      }
    };
  }

  function mediana(arr) {
    var v = arr.filter(function (x) { return x !== null && isFinite(x); }).sort(function (a, b) { return a - b; });
    return v.length ? v[Math.floor(v.length / 2)] : null;
  }

  function ventanaTxt(k, d) {
    var dt = [];
    for (var i = 1; i < d.t.length; i++) dt.push(d.t[i] - d.t[i - 1]);
    var m = mediana(dt);
    return '±' + k + ' muestras' + (m ? ' (≈ ±' + fmt(k * m, 2, 's') + ')' : '');
  }

  function pm(m, unit) { return m === null ? '—' : '±' + fmt(2 * m, 2, unit); }

  function drawInfo(list) {
    var ul = $('deriv-info');
    ul.textContent = '';
    list.forEach(function (f) {
      var dv = f.data.deriv;
      var li = el('li');
      var sw = el('span', 'sw'); sw.style.background = f.color; sw.setAttribute('aria-hidden', 'true');
      li.appendChild(sw);
      li.appendChild(el('strong', null, nombre(f) + ': '));
      li.appendChild(document.createTextNode(
        'σ de la altitud estimada = ' + fmt(dv.sigmaH, 2, 'm') + ' (' + dv.fuenteSigma + ') · ' +
        'error de la velocidad ' + pm(mediana(dv.sv), 'm/s') + ' (2σ) · ' +
        'error de la aceleración ' + pm(mediana(dv.sa), 'm/s²') + ' (2σ) · ' +
        'ventanas: velocidad ' + ventanaTxt(dv.kv, f.data) + ', aceleración ' + ventanaTxt(dv.ka, f.data) + '. ' +
        'Error calculado: ' + dv.fuenteError + '.' +
        (dv.sigmaPiso ? ' Nota: σ de la altitud en el piso mínimo (0,05 m); el ruido real puede ser mayor.' : '')));
      ul.appendChild(li);
    });
  }

  function destroyDeriv() {
    if (chartV) { chartV.destroy(); chartV = null; }
    if (chartA) { chartA.destroy(); chartA = null; }
  }

  function drawDeriv() {
    destroyDeriv();
    if (!detDeriv.open || typeof Chart === 'undefined') return;
    var list = visibles();
    drawInfo(list);
    if (!list.length) return;
    var tema = temaPantalla(), rx = rangoX(list);
    chartV = new Chart($('grafico-v'), derivConfig(list, tema, 'v', 'sv', 'Velocidad vertical (m/s)', 'm/s', rx));
    chartA = new Chart($('grafico-a'), derivConfig(list, tema, 'a', 'sa', 'Aceleración vertical (m/s²)', 'm/s²', rx));
  }

  function updateChartLabels() {
    updateDerivLabels();
    if (!chart) return;
    var list = visibles();
    chart.data.datasets.forEach(function (ds, i) {
      var f = list[Math.floor(i / 2)];
      if (f) ds.label = i % 2 ? nombre(f) + ' (apogeo)' : nombre(f);
    });
    chart.update('none');
  }

  function updateDerivLabels() {
    [chartV, chartA].forEach(function (c) {
      if (!c) return;
      c.data.datasets.forEach(function (ds) {
        var f = flights.filter(function (x) { return x.id === ds.fid; })[0];
        if (!f) return;
        var suf = ds.esBanda ? (ds.label.indexOf('(+') >= 0 ? ' (+2σ)' : ' (−2σ)') : '';
        ds.label = nombre(f) + suf;
      });
      c.update('none');
    });
    drawInfo(visibles());
  }

  /* ---------- tarjetas ---------- */
  function statItem(dt, value, note) {
    var d = el('div');
    d.appendChild(el('dt', null, dt));
    var dd = el('dd', null, value);
    if (note) { dd.appendChild(document.createElement('br')); dd.appendChild(el('span', 'est', note)); }
    d.appendChild(dd);
    return d;
  }

  function buildCard(f) {
    var s = f.data.stats;
    var card = el('article', 'card');
    card.dataset.id = f.id;
    card.style.setProperty('--c', f.color);

    var top = el('div', 'card-top');
    top.appendChild(el('span', 'file', 'Archivo: ' + f.fileName));
    var rm = el('button', 'btn btn-sm', 'Quitar');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Quitar el vuelo ' + f.fileName);
    rm.addEventListener('click', function (e) { e.stopPropagation(); removeFlight(f.id); });
    top.appendChild(rm);
    card.appendChild(top);

    card.appendChild(el('p', 'big-label', 'Altura máxima'));
    var big = el('p', 'big', fmt(s.altMax, 1));
    big.appendChild(el('small', null, 'm'));
    card.appendChild(big);

    var dl = el('dl', 'stats');
    dl.appendChild(statItem('Tiempo hasta el apogeo', fmt(s.tApogeo, 2, 's')));
    dl.appendChild(statItem('Duración del vuelo', fmt(s.duracion, 1, 's')));
    dl.appendChild(statItem('Vel. máx. de ascenso',
      fmt(s.vAscMax, 1) + (s.vAscMaxErr === null ? '' : ' ± ' + fmt(s.vAscMaxErr, 1)) + ' m/s', 'estimada · error 2σ'));
    dl.appendChild(statItem('Aceleración máx. (estimada)',
      fmt(s.aMax, 1) + (s.aMaxErr === null ? '' : ' ± ' + fmt(s.aMaxErr, 1)) + ' m/s²', 'estimada · error 2σ'));
    dl.appendChild(statItem('Vel. de descenso prom.', fmt(s.vDescProm, 1, 'm/s'),
      s.vDescProm === null ? 'sin datos suficientes' : 'del apogeo −10 % a 10 m'));
    card.appendChild(dl);

    var lab = el('label', 'field', 'Nombre del cohete / alumno (opcional)');
    var inp = document.createElement('input');
    inp.type = 'text'; inp.maxLength = 60; inp.value = f.label; inp.placeholder = f.fileName;
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
    inp.addEventListener('input', function () { f.label = inp.value; updateChartLabels(); });
    lab.appendChild(inp);
    card.appendChild(lab);

    if (f.data.ignoredLines > 0) {
      card.appendChild(el('p', 'file', 'Se ignoraron ' + f.data.ignoredLines + ' línea(s) mal formada(s).'));
    }

    card.addEventListener('click', function () { selectFlight(f.id); });
    return card;
  }

  function markSelected() {
    Array.prototype.forEach.call(cardsEl.children, function (c) {
      var on = Number(c.dataset.id) === selectedId;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-current', on ? 'true' : 'false');
    });
  }

  function selectFlight(id) {
    selectedId = id;
    markSelected();
    drawChart();
  }

  function removeFlight(id) {
    flights = flights.filter(function (f) { return f.id !== id; });
    if (selectedId === id) selectedId = flights.length ? flights[flights.length - 1].id : null;
    render(false);
  }

  function render(scroll) {
    panel.hidden = flights.length === 0;
    cardsEl.textContent = '';
    flights.forEach(function (f) { cardsEl.appendChild(buildCard(f)); });
    markSelected();
    drawChart();
    if (scroll && flights.length) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- descargas ---------- */
  function downloadPNG() {
    var list = visibles();
    if (!list.length || typeof Chart === 'undefined') return;
    var W = 1400, H = 800, TOP = 80;
    var holder = document.createElement('canvas');
    holder.width = W; holder.height = H - TOP;
    var tema = { texto: '#14212e', grilla: '#d5dfea', fondo: '#ffffff' };
    var c = new Chart(holder, chartConfig(list, tema, true));
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    var titulo;
    if (list.length === 1) {
      titulo = nombre(list[0]) + ' — Altura máxima: ' + fmt(list[0].data.stats.altMax, 1, 'm');
    } else {
      titulo = 'Comparación de vuelos — ' + list.map(function (f) {
        return nombre(f) + ' ' + fmt(f.data.stats.altMax, 1, 'm');
      }).join(' · ');
    }
    var size = 34;
    ctx.fillStyle = '#14212e';
    ctx.textBaseline = 'middle';
    do { ctx.font = '700 ' + size + 'px system-ui, sans-serif'; size -= 2; }
    while (ctx.measureText(titulo).width > W - 60 && size > 14);
    ctx.fillText(titulo, 30, TOP / 2 + 4);
    ctx.drawImage(holder, 0, TOP);
    c.destroy();
    var base = list.length === 1 ? slug(nombre(list[0])) : 'comparacion';
    out.toBlob(function (b) { download(b, 'grafico_' + base + '.png'); }, 'image/png');
  }

  function num(v, d) { return v === null || v === undefined ? '' : v.toFixed(d); }

  function derCols(d, i) {
    var dv = d.deriv;
    return [num(dv.v[i], 2), num(dv.a[i], 2), dv.sv[i] === null ? '' : (2 * dv.sv[i]).toFixed(2), dv.sa[i] === null ? '' : (2 * dv.sa[i]).toFixed(2)];
  }

  function downloadCSV() {
    var list = visibles();
    if (!list.length) return;
    var lines, name;
    if (list.length === 1) {
      var f = list[0], d = f.data;
      lines = ['# vuelo: ' + nombre(f), '# archivo: ' + f.fileName,
        '# altitud_max_m: ' + d.stats.altMax.toFixed(2), '# tiempo_apogeo_s: ' + d.stats.tApogeo.toFixed(3),
        '# velocidad_ms y acel_ms2: estimadas; err_vel y err_acel: error aleatorio 2σ',
        'tiempo_s,altitud_m,presion_Pa,temperatura_C,velocidad_ms,acel_ms2,err_vel,err_acel'];
      for (var i = 0; i < d.t.length; i++) {
        lines.push([d.t[i].toFixed(3), d.alt[i].toFixed(2), d.pres ? num(d.pres[i], 1) : '', d.temp ? num(d.temp[i], 1) : '']
          .concat(derCols(d, i)).join(','));
      }
      name = 'telemetria_' + slug(nombre(f)) + '.csv';
    } else {
      var cols = 'vuelo,tiempo_s,altitud_m,presion_Pa,temperatura_C,velocidad_ms,acel_ms2,err_vel,err_acel';
      lines = [];
      list.forEach(function (f, k) {
        lines.push('# vuelo_' + (k + 1) + ': ' + (nombre(f) + ' (' + f.fileName + ')').replace(/[\r\n]+/g, ' '));
      });
      lines.push('# columnas: ' + cols, cols);
      list.forEach(function (f, k) {
        var d = f.data;
        for (var i = 0; i < d.t.length; i++) {
          lines.push([k + 1, d.t[i].toFixed(3), d.alt[i].toFixed(2), d.pres ? num(d.pres[i], 1) : '', d.temp ? num(d.temp[i], 1) : '']
            .concat(derCols(d, i)).join(','));
        }
      });
      name = 'telemetria_comparacion.csv';
    }
    download(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), name);
  }

  /* ---------- eventos ---------- */
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  $('btn-elegir').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { handleFiles(fileInput.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.add('activa'); });
  });
  ['dragleave', 'drop'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.remove('activa'); });
  });
  dropzone.addEventListener('drop', function (e) { handleFiles(e.dataTransfer && e.dataTransfer.files); });
  // evitar que el navegador abra el archivo si se suelta fuera de la zona
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  $('link-ejemplo').addEventListener('click', loadExamples);
  chkSuperponer.addEventListener('change', drawChart);
  chkBandas.addEventListener('change', drawDeriv);
  detDeriv.addEventListener('toggle', drawDeriv);
  $('btn-png').addEventListener('click', downloadPNG);
  $('btn-csv').addEventListener('click', downloadCSV);
  $('btn-limpiar').addEventListener('click', function () {
    flights = []; selectedId = null; clearErrors(); render(false);
  });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', drawChart);
  }

  // para pruebas desde la consola
  window.__gce = { get flights() { return flights; } };
})();
