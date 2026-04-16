const srcFilesState = {
  files: [],
  worker: null,
  resultBlobs: [],
  taskType: 'convert',
  zipName: null,
  previewUrls: [],
  previewSeed: 0,
  convertSettings: {
    outputTemplate: localStorage.getItem('fontProcessor_convert_outputTpl') || '',
    previewText: localStorage.getItem('fontProcessor_convert_previewText') || '我爱的小字体预览:(Abc123)',
    compatLayer: localStorage.getItem('fontProcessor_convert_compatLayer') || 'ios18',
    outputFormat: localStorage.getItem('fontProcessor_convert_outputFormat') || 'ttc',
    offsets: {
      sizeOffset: parseInt(localStorage.getItem('fontProcessor_convert_sizeOffset') || '0', 10) || 0,
      weightOffset: parseInt(localStorage.getItem('fontProcessor_convert_weightOffset') || '0', 10) || 0,
      lineHeightOffset: parseInt(localStorage.getItem('fontProcessor_convert_lineHeightOffset') || '0', 10) || 0
    }
  },
  extractSettings: {
    outputTemplate: localStorage.getItem('fontProcessor_extract_outputTpl') || '',
    previewText: localStorage.getItem('fontProcessor_extract_previewText') || '我爱的小字体预览:(Abc123)',
    offsets: {
      sizeOffset: parseInt(localStorage.getItem('fontProcessor_extract_sizeOffset') || '0', 10) || 0,
      weightOffset: parseInt(localStorage.getItem('fontProcessor_extract_weightOffset') || '0', 10) || 0,
      lineHeightOffset: parseInt(localStorage.getItem('fontProcessor_extract_lineHeightOffset') || '0', 10) || 0
    }
  }
};

function initFontProcessorApp() {
  const $ = s => document.querySelector(s);
  const srcBox = $('#src-box');
  const srcInput = $('#src-input');
  const srcInfo = $('#src-info');
  const convertBtn = $('#convert-btn');
  const progressWrap = $('#progress-wrap');
  const progressFill = $('#progress-fill');
  const progressText = $('#progress-text');
  const logShell = $('#log-shell');
  const logScroll = $('#log-scroll');
  const resultsDiv = $('#results');
  const weightConfig = $('#weight-config');
  const convertSettingsShell = $('#convert-settings-shell');
  const convertSettingsToggle = $('#convert-settings-toggle');
  const convertSettingsPanel = $('#convert-settings-panel');
  const extractSettingsShell = $('#extract-settings-shell');
  const extractSettingsToggle = $('#extract-settings-toggle');
  const extractSettingsPanel = $('#extract-settings-panel');
  const ico = n => '<svg class="ico"><use href="#ico-' + n + '"/></svg>';

  const convertControls = {
    outputTpl: $('#convert-output-tpl'),
    previewText: $('#convert-preview-text'),
    sizeVal: $('#convert-size-val'),
    weightVal: $('#convert-weight-val'),
    lhVal: $('#convert-lh-val')
  };

  const extractControls = {
    outputTpl: $('#extract-output-tpl'),
    previewText: $('#extract-preview-text'),
    sizeVal: $('#extract-size-val'),
    weightVal: $('#extract-weight-val'),
    lhVal: $('#extract-lh-val')
  };

  function persistConvertSettings() {
    const s = srcFilesState.convertSettings;
    localStorage.setItem('fontProcessor_convert_outputTpl', s.outputTemplate);
    localStorage.setItem('fontProcessor_convert_previewText', s.previewText);
    localStorage.setItem('fontProcessor_convert_compatLayer', s.compatLayer);
    localStorage.setItem('fontProcessor_convert_outputFormat', s.outputFormat);
    localStorage.setItem('fontProcessor_convert_sizeOffset', String(s.offsets.sizeOffset));
    localStorage.setItem('fontProcessor_convert_weightOffset', String(s.offsets.weightOffset));
    localStorage.setItem('fontProcessor_convert_lineHeightOffset', String(s.offsets.lineHeightOffset));
  }

  function persistExtractSettings() {
    const s = srcFilesState.extractSettings;
    localStorage.setItem('fontProcessor_extract_outputTpl', s.outputTemplate);
    localStorage.setItem('fontProcessor_extract_previewText', s.previewText);
    localStorage.setItem('fontProcessor_extract_sizeOffset', String(s.offsets.sizeOffset));
    localStorage.setItem('fontProcessor_extract_weightOffset', String(s.offsets.weightOffset));
    localStorage.setItem('fontProcessor_extract_lineHeightOffset', String(s.offsets.lineHeightOffset));
  }

  function syncConvertControls() {
    convertControls.outputTpl.value = srcFilesState.convertSettings.outputTemplate;
    convertControls.previewText.value = srcFilesState.convertSettings.previewText;
    convertControls.sizeVal.value = srcFilesState.convertSettings.offsets.sizeOffset;
    convertControls.weightVal.value = srcFilesState.convertSettings.offsets.weightOffset;
    convertControls.lhVal.value = srcFilesState.convertSettings.offsets.lineHeightOffset;
    const compat = document.querySelector(`input[name="compat-layer"][value="${srcFilesState.convertSettings.compatLayer}"]`);
    if (compat) compat.checked = true;
    const format = document.querySelector(`input[name="output-format"][value="${srcFilesState.convertSettings.outputFormat}"]`);
    if (format) format.checked = true;
  }

  function syncExtractControls() {
    extractControls.outputTpl.value = srcFilesState.extractSettings.outputTemplate;
    extractControls.previewText.value = srcFilesState.extractSettings.previewText;
    extractControls.sizeVal.value = srcFilesState.extractSettings.offsets.sizeOffset;
    extractControls.weightVal.value = srcFilesState.extractSettings.offsets.weightOffset;
    extractControls.lhVal.value = srcFilesState.extractSettings.offsets.lineHeightOffset;
  }

  function clearPreviewUrls() {
    srcFilesState.previewUrls.forEach(url => URL.revokeObjectURL(url));
    srcFilesState.previewUrls = [];
  }

  function currentSettings() {
    return srcFilesState.taskType === 'extract' ? srcFilesState.extractSettings : srcFilesState.convertSettings;
  }

  function setButtonIdle() {
    convertBtn.classList.remove('running');
    if (!srcFilesState.files.length) {
      convertBtn.textContent = '等放好文件再点我哦 (๑•̀ㅂ•́)و✧';
      return;
    }
    convertBtn.textContent = srcFilesState.taskType === 'extract'
      ? '开始生成 SFUI (๑•̀ㅂ•́)و✧'
      : '开始转换 UI 字体 (๑•̀ㅂ•́)و✧';
  }

  function addLog(level, text, icon) {
    const time = new Date().toLocaleTimeString('zh-CN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const line = document.createElement('div');
    line.className = `log-line ${level}`;
    line.textContent = `[${time}] ${text}`;
    if (icon) {
      const s = document.createElement('span');
      s.innerHTML = ' ' + ico(icon);
      line.appendChild(s);
    }
    logScroll.appendChild(line);
    requestAnimationFrame(() => { logScroll.scrollTop = logScroll.scrollHeight; });
  }

  function checkReady() {
    convertBtn.disabled = srcFilesState.files.length === 0;
  }

  function getTaskType() {
    const checked = document.querySelector('input[name="task-type"]:checked');
    return checked ? checked.value : 'convert';
  }

  function renderSelectedFiles() {
    if (!srcFilesState.files.length) {
      clearPreviewUrls();
      srcInfo.textContent = '还木有选择文件呢...';
      srcBox.classList.remove('loaded');
      return;
    }

    clearPreviewUrls();
    srcFilesState.previewSeed += 1;
    const settings = currentSettings();
    const previewText = settings.previewText || '我爱的小字体预览:(Abc123)';
    const secondLine = srcFilesState.taskType === 'extract'
      ? 'SFUI / Abc123 / 0123456789'
      : 'Abc123 / Font处理器';
    const previewCount = Math.min(srcFilesState.files.length, 3);
    const previewSize = Math.max(12, 22 + Math.round(settings.offsets.sizeOffset / 40));
    const previewWeight = Math.max(1, 400 + settings.offsets.weightOffset);
    const previewLineHeight = Math.max(1, 1.35 + settings.offsets.lineHeightOffset / 1000);
    const strokePx = settings.offsets.weightOffset > 0 ? (settings.offsets.weightOffset / 200).toFixed(2) : 0;
    const strokeStyle = strokePx > 0 ? `-webkit-text-stroke:${strokePx}px currentColor;` : '';
    let styleCss = '';
    let html = `<div class="file-chip">${srcFilesState.files.length} 个小可爱</div><div class="preview-list">`;

    for (let i = 0; i < previewCount; i++) {
      const file = srcFilesState.files[i];
      const blob = new Blob([file.buffer]);
      const url = URL.createObjectURL(blob);
      srcFilesState.previewUrls.push(url);
      const family = `preview_font_${srcFilesState.previewSeed}_${i}`;
      styleCss += `@font-face{font-family:"${family}";src:url("${url}");font-weight:1 999;}\n`;
      html += `
        <div class="preview-item">
          <div class="preview-name">${file.name}</div>
          <div class="preview-text-render" style="font-family:'${family}';font-size:${previewSize}px;font-weight:${previewWeight};line-height:${previewLineHeight.toFixed(2)};${strokeStyle}">${previewText}\n${secondLine}</div>
        </div>
      `;
    }

    if (srcFilesState.files.length > previewCount) {
      html += `<div class="preview-more">...还有 ${srcFilesState.files.length - previewCount} 个文件等着变身</div>`;
    }
    html += '</div>';

    let styleEl = $('#preview-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'preview-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = styleCss;
    srcInfo.innerHTML = html;
    srcBox.classList.add('loaded');
  }

  function updateTaskUi() {
    srcFilesState.taskType = getTaskType();
    const isExtract = srcFilesState.taskType === 'extract';
    weightConfig.classList.toggle('is-hidden', isExtract);
    convertSettingsShell.classList.toggle('is-hidden', isExtract);
    extractSettingsShell.classList.toggle('is-hidden', !isExtract);
    if (isExtract) {
      convertSettingsPanel.classList.remove('show');
      convertSettingsToggle.classList.remove('is-open');
    } else {
      extractSettingsPanel.classList.remove('show');
      extractSettingsToggle.classList.remove('is-open');
    }
    renderSelectedFiles();
    setButtonIdle();
  }

  function setupDrop(box, input, onFiles) {
    ['dragenter', 'dragover'].forEach(e => box.addEventListener(e, ev => {
      ev.preventDefault();
      box.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(e => box.addEventListener(e, ev => {
      ev.preventDefault();
      box.classList.remove('drag-over');
    }));
    box.addEventListener('drop', ev => {
      if (ev.dataTransfer.files.length) onFiles(ev.dataTransfer.files);
    });
    input.addEventListener('change', () => {
      if (input.files.length) onFiles(input.files);
    });
  }

  setupDrop(srcBox, srcInput, async files => {
    srcFilesState.files = [];
    for (const f of files) {
      srcFilesState.files.push({ name: f.name, buffer: await f.arrayBuffer() });
    }
    renderSelectedFiles();
    checkReady();
    setButtonIdle();
  });

  function addResult(name, buffer) {
    const blob = new Blob([buffer], { type: name.toLowerCase().endsWith('.ttf') ? 'font/ttf' : 'font/collection' });
    const url = URL.createObjectURL(blob);
    srcFilesState.resultBlobs.push({ name, blob, url });

    const item = document.createElement('div');
    item.className = 'result-item';
    const main = document.createElement('div');
    main.className = 'result-main';

    const resultName = document.createElement('span');
    resultName.className = 'result-name';
    resultName.innerHTML = `${name} ${ico('sparkle')}`;
    main.appendChild(resultName);

    const resultTip = document.createElement('span');
    resultTip.className = 'result-tip';
    resultTip.innerHTML = `${srcFilesState.taskType === 'extract' ? '完整 SFUI 已经准备好啦~' : '做好了哦！快点下载吧~'} ${ico('gift')}`;
    main.appendChild(resultTip);

    const size = document.createElement('span');
    size.className = 'result-size';
    size.textContent = `${(buffer.byteLength / 1048576).toFixed(1)} MB`;

    const dl = document.createElement(srcFilesState.taskType === 'extract' ? 'button' : 'a');
    dl.className = 'dl-btn';
    if (srcFilesState.taskType === 'extract') {
      dl.type = 'button';
      dl.textContent = '带我走吧!';
      dl.addEventListener('click', async () => {
        dl.disabled = true;
        const oldText = dl.textContent;
        dl.textContent = '打包中...';
        try {
          const zip = new JSZip();
          zip.file(name, blob);
          const zipBlob = await zip.generateAsync({ type: 'blob' });
          const zipUrl = URL.createObjectURL(zipBlob);
          const a = document.createElement('a');
          a.href = zipUrl;
          a.download = `${name.replace(/\.[^.]+$/, '')}.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(zipUrl), 1000);
        } catch (err) {
          addLog('err', `打包下载失败: ${err.message || String(err)}`);
        } finally {
          dl.disabled = false;
          dl.textContent = oldText;
        }
      });
    } else {
      dl.href = url;
      dl.download = name;
      dl.textContent = '带我走吧!';
    }

    item.appendChild(main);
    item.appendChild(size);
    item.appendChild(dl);
    resultsDiv.appendChild(item);
  }

  function collectConvertSettings() {
    const s = srcFilesState.convertSettings;
    return {
      compatLayer: s.compatLayer,
      outputFormat: s.outputFormat,
      outputTemplate: s.outputTemplate.trim() || '${fontName}UI',
      offsets: { ...s.offsets }
    };
  }

  function collectExtractSettings() {
    const s = srcFilesState.extractSettings;
    return {
      outputTemplate: s.outputTemplate.trim() || '${fontName}-SFUI',
      previewText: s.previewText,
      offsets: { ...s.offsets }
    };
  }

  function updateConvertOffset(target, value) {
    const o = srcFilesState.convertSettings.offsets;
    if (target === 'size') o.sizeOffset = value;
    if (target === 'weight') o.weightOffset = value;
    if (target === 'lineHeight') o.lineHeightOffset = value;
    persistConvertSettings();
    syncConvertControls();
    if (srcFilesState.taskType === 'convert') renderSelectedFiles();
  }

  function updateExtractOffset(target, value) {
    const o = srcFilesState.extractSettings.offsets;
    if (target === 'size') o.sizeOffset = value;
    if (target === 'weight') o.weightOffset = value;
    if (target === 'lineHeight') o.lineHeightOffset = value;
    persistExtractSettings();
    syncExtractControls();
    if (srcFilesState.taskType === 'extract') renderSelectedFiles();
  }

  convertSettingsToggle.addEventListener('click', () => {
    convertSettingsToggle.classList.toggle('is-open');
    convertSettingsPanel.classList.toggle('show');
  });

  extractSettingsToggle.addEventListener('click', () => {
    extractSettingsToggle.classList.toggle('is-open');
    extractSettingsPanel.classList.toggle('show');
  });

  convertControls.outputTpl.addEventListener('input', () => {
    srcFilesState.convertSettings.outputTemplate = convertControls.outputTpl.value;
    persistConvertSettings();
  });
  convertControls.previewText.addEventListener('input', () => {
    srcFilesState.convertSettings.previewText = convertControls.previewText.value;
    persistConvertSettings();
    if (srcFilesState.taskType === 'convert') renderSelectedFiles();
  });
  convertControls.sizeVal.addEventListener('change', () => updateConvertOffset('size', parseInt(convertControls.sizeVal.value || '0', 10) || 0));
  convertControls.weightVal.addEventListener('change', () => updateConvertOffset('weight', parseInt(convertControls.weightVal.value || '0', 10) || 0));
  convertControls.lhVal.addEventListener('change', () => updateConvertOffset('lineHeight', parseInt(convertControls.lhVal.value || '0', 10) || 0));

  extractControls.outputTpl.addEventListener('input', () => {
    srcFilesState.extractSettings.outputTemplate = extractControls.outputTpl.value;
    persistExtractSettings();
  });
  extractControls.previewText.addEventListener('input', () => {
    srcFilesState.extractSettings.previewText = extractControls.previewText.value;
    persistExtractSettings();
    if (srcFilesState.taskType === 'extract') renderSelectedFiles();
  });
  extractControls.sizeVal.addEventListener('change', () => updateExtractOffset('size', parseInt(extractControls.sizeVal.value || '0', 10) || 0));
  extractControls.weightVal.addEventListener('change', () => updateExtractOffset('weight', parseInt(extractControls.weightVal.value || '0', 10) || 0));
  extractControls.lhVal.addEventListener('change', () => updateExtractOffset('lineHeight', parseInt(extractControls.lhVal.value || '0', 10) || 0));

  document.querySelectorAll('input[name="compat-layer"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        srcFilesState.convertSettings.compatLayer = input.value;
        persistConvertSettings();
      }
    });
  });

  document.querySelectorAll('input[name="output-format"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        srcFilesState.convertSettings.outputFormat = input.value;
        persistConvertSettings();
      }
    });
  });

  document.querySelectorAll('.offset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group || 'convert';
      const target = btn.dataset.target;
      const delta = parseInt(btn.dataset.delta || '0', 10) || 0;
      if (group === 'extract') {
        const offsets = srcFilesState.extractSettings.offsets;
        const current = target === 'size' ? offsets.sizeOffset : target === 'weight' ? offsets.weightOffset : offsets.lineHeightOffset;
        updateExtractOffset(target, current + delta);
      } else {
        const offsets = srcFilesState.convertSettings.offsets;
        const current = target === 'size' ? offsets.sizeOffset : target === 'weight' ? offsets.weightOffset : offsets.lineHeightOffset;
        updateConvertOffset(target, current + delta);
      }
    });
  });

  async function ensureReferenceBuffer() {
    addLog('ok', '已经准备就位。', 'gift');
    return null;
  }

  convertBtn.addEventListener('click', async () => {
    if (!srcFilesState.files.length) return;

    srcFilesState.taskType = getTaskType();
    srcFilesState.zipName = srcFilesState.taskType === 'extract'
      ? `SFUI-extract-${Date.now()}.zip`
      : `FontProcessor_${Date.now()}.zip`;
    resultsDiv.innerHTML = '';
    srcFilesState.resultBlobs = [];
    logScroll.innerHTML = '';
    logShell.classList.add('show');
    progressWrap.classList.add('show');
    progressFill.style.width = '0%';
    progressText.innerHTML = srcFilesState.taskType === 'extract'
      ? 'SFUI 生成准备就绪 ' + ico('wand')
      : '小魔法师准备就绪 ' + ico('wand');
    convertBtn.classList.add('running');
    convertBtn.innerHTML = srcFilesState.taskType === 'extract'
      ? '<span class="running-text">正在生成 SFUI... ' + ico('star') + '</span>'
      : '<span class="running-text">正在变身中... ' + ico('star') + '</span>';

    if (srcFilesState.worker) srcFilesState.worker.terminate();
    srcFilesState.worker = new Worker('worker.js?v=20260416-more-settings');

    srcFilesState.worker.onmessage = e => {
      const msg = e.data;
      switch (msg.type) {
        case 'log':
          addLog(msg.level, msg.text);
          break;
        case 'progress':
          progressFill.style.width = `${(msg.current / msg.total * 100).toFixed(0)}%`;
          progressText.innerHTML = srcFilesState.taskType === 'extract'
            ? `生成进度 ${msg.current} / ${msg.total} ${ico('wand')}`
            : `施法进度 ${msg.current} / ${msg.total} ${ico('wand')}`;
          break;
        case 'result':
          addResult(msg.name, msg.buffer);
          break;
        case 'done':
          addLog('ok', srcFilesState.taskType === 'extract' ? '完整 SFUI 全部生成完成啦！' : '魔法变身全部完成啦！', 'party');
          progressFill.style.width = '100%';
          progressText.innerHTML = srcFilesState.taskType === 'extract'
            ? 'SFUI 生成完成！' + ico('sparkle')
            : '大功告成！' + ico('sparkle');
          setButtonIdle();
          break;
        case 'error':
          addLog('err', msg.message);
          progressText.innerHTML = '哎呀，魔法失效了 ' + ico('sad');
          setButtonIdle();
          checkReady();
          break;
      }
    };

    srcFilesState.worker.onerror = e => {
      addLog('err', `Worker 错误: ${e.message}`);
      progressText.textContent = '处理失败';
      setButtonIdle();
    };

    const srcClones = srcFilesState.files.map(f => ({ name: f.name, buffer: f.buffer.slice(0) }));
    const transfers = srcClones.map(f => f.buffer);
    const checked = document.querySelector('input[name="weight-mode"]:checked');
    try {
      let payload;
      if (srcFilesState.taskType === 'extract') {
        await ensureReferenceBuffer();
        payload = {
          type: 'extract-sfui',
          srcFiles: srcClones,
          ...collectExtractSettings()
        };
      } else {
        payload = {
          type: 'convert',
          srcFiles: srcClones,
          mode: checked ? checked.value : 'single',
          ...collectConvertSettings()
        };
      }
      srcFilesState.worker.postMessage(payload, transfers);
    } catch (err) {
      addLog('err', err.message || String(err));
      progressText.textContent = '处理失败';
      setButtonIdle();
    }
  });

  document.querySelectorAll('input[name="task-type"]').forEach(input => {
    input.addEventListener('change', updateTaskUi);
  });

  syncConvertControls();
  syncExtractControls();
  checkReady();
  updateTaskUi();
  renderSelectedFiles();
}

document.addEventListener('DOMContentLoaded', initFontProcessorApp);
