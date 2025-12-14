let cancelRequested = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelRequested = true;
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

  for (const chunk of chunks) {
    if (cancelRequested) {
      console.debug('Translation canceled by user');
      break;
    }

    const texts = chunk.map(({ node }) => node.nodeValue);
    const result = await translate(texts, settings.targetLanguage || 'ru');
    if (result?.success) {
      chunk.forEach(({ node }, index) => {
        node.nodeValue = result.translations[index] || node.nodeValue;
      });
    }
  }
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
