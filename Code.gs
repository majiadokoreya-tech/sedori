const BACKUP_FOLDER_NAME = 'せどりバックアップ';
const BACKUP_FILE_PREFIX = 'せどり_Drive自動_PROD_';
const SHARED_FILE_NAME = 'せどり_共有データ.json';

// せどりアプリ側と同じ合言葉
const BACKUP_KEY = '1022052';

const MESSAGE_TYPE = 'SEDORI_GAS_BACKUP_RESULT';

function log_(label, value) {
  if (value === undefined) {
    console.log('[SEDORI] ' + label);
    return;
  }
  try {
    console.log('[SEDORI] ' + label + ' : ' + (typeof value === 'string' ? value : JSON.stringify(value)));
  } catch (err) {
    console.log('[SEDORI] ' + label + ' : ' + String(value));
  }
}

function doGet(e) {
  log_('doGet 受信');
  return makeResponse_({
    ok: true,
    action: 'ping',
    message: 'せどり PROD バックアップ / 2台共有同期 稼働中'
  });
}

function doPost(e) {
  const startedAt = new Date();
  log_('========================================');
  log_('doPost 開始');
  log_('開始時刻', startedAt.toISOString());

  try {
    const p = e && e.parameter ? e.parameter : {};
    const action = String(p.action || '').trim();
    const mode = String(p.mode || '').trim();

    log_('action', action);
    log_('mode', mode);
    log_('payload文字数', p.payload ? String(p.payload).length : 0);
    log_('合言葉受信', p.key ? 'あり' : 'なし');

    if (!p.key || p.key !== BACKUP_KEY) {
      log_('停止理由', '合言葉不一致');
      return makeResponse_({
        ok: false,
        action: action,
        error: '合言葉が一致しません'
      });
    }

    log_('合言葉確認', 'OK');

    if (action === 'ping') {
      log_('接続テスト', 'OK');
      return makeResponse_({
        ok: true,
        action: 'ping',
        message: 'せどりバックアップ接続OK'
      });
    }

    if (action === 'sync_pull') {
      return handleSyncPull_(p);
    }

    if (action === 'sync_push') {
      return handleSyncPush_(p);
    }

    if (action !== 'backup') {
      log_('停止理由', '不明なaction: ' + action);
      return makeResponse_({
        ok: false,
        action: action,
        error: '不明な操作です'
      });
    }

    return handleBackup_(p, mode);

  } catch (err) {
    log_('重大エラー', String(err && err.stack ? err.stack : err));
    log_('========================================');
    return makeResponse_({
      ok: false,
      action: 'backup',
      error: String(err && err.message ? err.message : err)
    });
  }
}

function handleBackup_(p, mode) {
  if (!p.payload) {
    log_('停止理由', 'payloadなし');
    return makeResponse_({
      ok: false,
      action: 'backup',
      error: 'バックアップデータがありません'
    });
  }

  let payload;
  try {
    payload = JSON.parse(p.payload);
    log_('JSON解析', 'OK');
  } catch (err) {
    log_('JSON解析失敗', String(err));
    return makeResponse_({
      ok: false,
      action: 'backup',
      error: 'バックアップJSONを読み取れません'
    });
  }

  log_('payload.app', payload ? payload.app : '');
  log_('payload.environment', payload ? payload.environment : '');
  log_('payload.backupMode', payload ? payload.backupMode : '');
  log_('payload.requestedAt', payload ? payload.requestedAt : '');

  if (payload && payload.environment && payload.environment !== 'PROD') {
    log_('停止理由', 'environment=' + payload.environment);
    return makeResponse_({
      ok: false,
      action: 'backup',
      error: 'TESTデータのためPRODへ保存しません'
    });
  }

  if (payload && payload.app && payload.app !== 'sedori') {
    log_('停止理由', 'app=' + payload.app);
    return makeResponse_({
      ok: false,
      action: 'backup',
      error: 'せどりアプリ以外のデータは保存しません'
    });
  }

  let retention = parseInt(p.retention || '7', 10);
  if (!isFinite(retention)) retention = 7;
  retention = Math.max(5, Math.min(10, retention));
  log_('保持件数', retention);

  const folder = getOrCreateFolder_(BACKUP_FOLDER_NAME);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const actualMode = mode || String(payload.backupMode || 'manual');
    const now = new Date();

    if (actualMode === 'daily-auto') {
      const duplicate = findRecentDailyBackup_(folder, payload, now);
      log_('日次重複判定', duplicate ? '重複あり' : '重複なし');
      if (duplicate) {
        return makeResponse_({
          ok: true,
          action: 'backup',
          duplicate: true,
          deleted: 0,
          kept: countBackupFiles_(folder),
          message: '同じ日次バックアップが既にあるため重複保存を省略しました'
        });
      }
    }

    const fileName =
      BACKUP_FILE_PREFIX +
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm-ss') +
      '.json';

    const backupData = JSON.stringify(payload, null, 2);
    log_('作成予定ファイル名', fileName);
    log_('Driveファイル作成', '開始');

    const createdFile = folder.createFile(fileName, backupData, MimeType.PLAIN_TEXT);
    log_('Driveファイル作成', '成功');
    log_('作成ファイルID', createdFile.getId());

    const cleanup = cleanupOldBackups_(folder, retention);
    log_('削除件数', cleanup.deleted);
    log_('保持件数', cleanup.kept);
    log_('バックアップ処理', '完全成功');

    return makeResponse_({
      ok: true,
      action: 'backup',
      fileName: fileName,
      fileId: createdFile.getId(),
      deleted: cleanup.deleted,
      kept: cleanup.kept,
      message: 'Google Driveへのバックアップが完了しました'
    });

  } finally {
    try {
      lock.releaseLock();
      log_('ロック解放', 'OK');
    } catch (lockError) {
      log_('ロック解放エラー', String(lockError));
    }
  }
}

function handleSyncPull_(p) {
  const folder = getOrCreateFolder_(BACKUP_FOLDER_NAME);
  const shared = readSharedFile_(folder);

  log_('共有同期 pull', shared ? '共有データあり' : '共有データなし');
  log_('要求端末', String(p.deviceName || '未設定端末'));

  if (!shared) {
    return makeResponse_({
      ok: true,
      action: 'sync_pull',
      exists: false,
      revision: 0,
      payload: null,
      updatedAt: '',
      updatedBy: ''
    });
  }

  return makeResponse_({
    ok: true,
    action: 'sync_pull',
    exists: true,
    revision: Number(shared.revision || 0),
    payload: shared.payload || null,
    updatedAt: String(shared.updatedAt || ''),
    updatedBy: String(shared.updatedBy || '')
  });
}

function handleSyncPush_(p) {
  if (!p.payload) {
    return makeResponse_({
      ok: false,
      action: 'sync_push',
      error: '共有データがありません'
    });
  }

  let payload;
  try {
    payload = JSON.parse(p.payload);
  } catch (err) {
    return makeResponse_({
      ok: false,
      action: 'sync_push',
      error: '共有データJSONを読み取れません'
    });
  }

  if (!payload || payload.app !== 'sedori') {
    return makeResponse_({
      ok: false,
      action: 'sync_push',
      error: 'せどり共有データではありません'
    });
  }

  if (payload.environment && payload.environment !== 'PROD') {
    return makeResponse_({
      ok: false,
      action: 'sync_push',
      error: 'TESTデータのため共有データへ保存しません'
    });
  }

  const expectedRevision = Math.max(0, parseInt(p.expectedRevision || '0', 10) || 0);
  const deviceName = String(p.deviceName || '未設定端末').trim() || '未設定端末';
  const deviceId = String(p.deviceId || '').trim();
  const folder = getOrCreateFolder_(BACKUP_FOLDER_NAME);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const current = readSharedFile_(folder);
    const currentRevision = current ? Math.max(0, Number(current.revision || 0)) : 0;

    log_('共有同期 push expectedRevision', expectedRevision);
    log_('共有同期 push currentRevision', currentRevision);
    log_('共有同期 push deviceName', deviceName);

    if (expectedRevision !== currentRevision) {
      log_('共有同期競合', 'revision不一致');
      return makeResponse_({
        ok: false,
        action: 'sync_push',
        conflict: true,
        error: '他端末の更新があります',
        revision: currentRevision,
        payload: current ? current.payload : null,
        updatedAt: current ? String(current.updatedAt || '') : '',
        updatedBy: current ? String(current.updatedBy || '') : ''
      });
    }

    const revision = currentRevision + 1;
    const now = new Date().toISOString();
    const wrapper = {
      app: 'sedori',
      environment: 'PROD',
      format: 'drive-shared-sync-v1',
      revision: revision,
      updatedAt: now,
      updatedBy: deviceName,
      updatedByDeviceId: deviceId,
      payload: payload
    };

    writeSharedFile_(folder, wrapper);
    log_('共有同期保存', '成功 revision ' + revision);

    return makeResponse_({
      ok: true,
      action: 'sync_push',
      revision: revision,
      updatedAt: now,
      updatedBy: deviceName,
      message: '共有データを更新しました'
    });

  } finally {
    try {
      lock.releaseLock();
    } catch (err) {}
  }
}

function readSharedFile_(folder) {
  const files = folder.getFilesByName(SHARED_FILE_NAME);
  if (!files.hasNext()) return null;

  const file = files.next();
  const raw = file.getBlob().getDataAsString('UTF-8');
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!data || data.app !== 'sedori' || !data.payload) {
      throw new Error('共有データ形式が正しくありません');
    }
    return data;
  } catch (err) {
    log_('共有データ読込エラー', String(err));
    throw new Error('Driveの共有データを読み取れません');
  }
}

function writeSharedFile_(folder, wrapper) {
  const content = JSON.stringify(wrapper, null, 2);
  const files = folder.getFilesByName(SHARED_FILE_NAME);

  if (files.hasNext()) {
    const file = files.next();
    file.setContent(content);

    // 同名ファイルが複数ある場合は古い重複をゴミ箱へ
    while (files.hasNext()) {
      files.next().setTrashed(true);
    }
    return file;
  }

  return folder.createFile(SHARED_FILE_NAME, content, MimeType.PLAIN_TEXT);
}

function getOrCreateFolder_(folderName) {
  const folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    const folder = folders.next();
    log_('既存フォルダ使用', folder.getId());
    return folder;
  }

  log_('フォルダ新規作成', folderName);
  const folder = DriveApp.createFolder(folderName);
  log_('新規フォルダID', folder.getId());
  return folder;
}

function cleanupOldBackups_(folder, retention) {
  const files = [];
  const iterator = folder.getFiles();

  while (iterator.hasNext()) {
    const file = iterator.next();
    if (file.getName().indexOf(BACKUP_FILE_PREFIX) === 0) {
      files.push(file);
    }
  }

  files.sort(function(a, b) {
    return b.getDateCreated().getTime() - a.getDateCreated().getTime();
  });

  let deleted = 0;
  for (let i = retention; i < files.length; i++) {
    files[i].setTrashed(true);
    deleted++;
  }

  return {
    deleted: deleted,
    kept: Math.min(files.length, retention)
  };
}

function countBackupFiles_(folder) {
  let count = 0;
  const iterator = folder.getFiles();

  while (iterator.hasNext()) {
    const file = iterator.next();
    if (file.getName().indexOf(BACKUP_FILE_PREFIX) === 0) count++;
  }

  return count;
}

function findRecentDailyBackup_(folder, payload, now) {
  const requestedAt = String(payload.requestedAt || '');
  const today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const iterator = folder.getFiles();

  while (iterator.hasNext()) {
    const file = iterator.next();
    if (file.getName().indexOf(BACKUP_FILE_PREFIX) !== 0) continue;

    const created = file.getDateCreated();
    const createdDay = Utilities.formatDate(created, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (createdDay !== today) continue;
    if (now.getTime() - created.getTime() > 5 * 60 * 1000) continue;

    try {
      const oldPayload = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if (oldPayload.backupMode === 'daily-auto') {
        if (requestedAt && oldPayload.requestedAt === requestedAt) return true;
        return true;
      }
    } catch (err) {
      log_('重複判定JSON読込エラー', file.getName());
    }
  }

  return false;
}

function makeResponse_(data) {
  data.type = MESSAGE_TYPE;

  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const html =
    '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8"></head><body>' +
    '<script>' +
    'try{window.top.postMessage(' + json + ',"*");}catch(e){}' +
    'try{window.parent.postMessage(' + json + ',"*");}catch(e){}' +
    '</scr' + 'ipt>' +
    '</body></html>';

  return HtmlService
    .createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
