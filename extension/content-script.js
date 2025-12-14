let cancelRequested = false;
let translationProgress = { completedChunks: 0, totalChunks: 0 };

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelRequested = true;
    reportProgress('Перевод отменён', translationProgress.completedChunks, translationProgress.totalChunks);
  }
});

(async function init() {
  const settings = await requestSettings();
  if (!settings?.allowed) {
    return;
  }

  translatePage(settings);
})();

async function requestSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS', url: location.href }, (response) => {
      resolve(response);
    });
  });
}

async function translatePage(settings) {
  const textNodes = collectTextNodes(document.body);
  const chunks = chunkNodes(textNodes, 800);
  translationProgress = { completedChunks: 0, totalChunks: chunks.length };

  if (!chunks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return;
  }

  cancelRequested = false;
  reportProgress('Перевод запущен', 0, chunks.length);

  const maxConcurrency = Math.min(4, chunks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (cancelRequested) return;
      const currentIndex = nextIndex++;
      if (currentIndex >= chunks.length) return;
      const chunk = chunks[currentIndex];
      const texts = chunk.map(({ node }) => node.nodeValue);

      try {
        const result = await translate(texts, settings.targetLanguage || 'ru');
        if (result?.success) {
          chunk.forEach(({ node }, index) => {
            node.nodeValue = result.translations[index] || node.nodeValue;
          });
        }
      } catch (error) {
        console.error('Chunk translation failed', error);
        reportProgress('Ошибка перевода', translationProgress.completedChunks, chunks.length);
      }

      translationProgress.completedChunks += 1;
      reportProgress('Перевод выполняется', translationProgress.completedChunks, chunks.length);
    }
  };

  const workers = Array.from({ length: maxConcurrency }, () => worker());
  await Promise.all(workers);

  if (cancelRequested) {
    reportProgress('Перевод отменён', translationProgress.completedChunks, chunks.length);
    return;
  }

  reportProgress('Перевод завершён', translationProgress.completedChunks, chunks.length);
}

async function translate(texts, targetLanguage) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_TEXT',
        texts,
        targetLanguage
      },
      (response) => resolve(response)
    );
  });
}

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentNode;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.nodeName.toLowerCase();
      if (['script', 'style', 'noscript', 'code', 'pre'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}

function chunkNodes(nodes, maxLength) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  nodes.forEach((node) => {
    const text = node.nodeValue;
    if (currentLength + text.length > maxLength && currentChunk.length) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLength = 0;
    }
    currentChunk.push({ node });
    currentLength += text.length;
  });

  if (currentChunk.length) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function reportProgress(message, completedChunks, totalChunks) {
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_PROGRESS',
    message,
    completedChunks,
    totalChunks
  });
}
