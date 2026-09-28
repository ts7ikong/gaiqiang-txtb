// 点击扩展图标时才注入同步脚本，不再在每个腾讯文档页面自动弹出面板
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https:\/\/docs\.qq\.com\/sheet\//.test(tab.url || '')) {
    // 非腾讯表格页面：用角标提示一下
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }), 1500);
    return;
  }
  // 重复点击时脚本内部的全局标记会直接重新打开面板
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['tencent_sync.js'] });
});
