'use strict';

/**
 * preload.js
 * Electron の contextBridge でrendererに安全なAPIを公開する。
 * window.electronAPI として使える。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ジョブ実行
  run: (job) => ipcRenderer.invoke('crawler:run', job),

  // ステータス取得
  status: () => ipcRenderer.invoke('crawler:status'),

  // 完了通知を受け取る
  onDone: (cb) => ipcRenderer.on('crawler:done', (_, data) => cb(data)),

  // 開始通知
  onStarted: (cb) => ipcRenderer.on('crawler:started', (_, data) => cb(data)),
});
