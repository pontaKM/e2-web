/*
 * e2core.js  —  electribe2 用の土台（接続層＋状態層）  v9
 *
 * 基本方針（v6〜）：
 *   再生中の e2 にダンプを要求すると、データが欠けるうえに演奏がつっかえる（実機で確認）。
 *   そこで「再生中は e2 にダンプを一切要求しない」。
 *     - 停止中に、保存済みパターンを番号指定で読み込んでおく（先読み）
 *     - 再生中のパターン切替は、予測した切替時刻に、先読みしたデータで表示を切り替える
 *       （e2 は保存せずにパターンを切り替えると編集が元に戻る＝切替後は保存データと同じ）
 *     - 再生中のつまみ操作は CC で即時に反映
 *     - 停止したら1回だけ読み直して、表示が正しかったか確かめる
 *
 * v8：先読みデータが古くなる問題への対策（本体で保存し直したパターンを、iPad の古いデータで表示してしまう）
 *     - 停止したら、今のパターンの保存データも読み直して、先読みデータを新しくする
 *     - 停止中にパターンを切り替えたら、切替前のパターンの保存データを読み直す（保存してから切り替えた場合）
 *     - 停止中にパターンを切り替えた直後の本体データ＝保存データなので、それで先読みデータを新しくする
 *     - 停止中は数秒おきに、今のパターンの保存データを確かめる（停止中に保存した場合）
 *     - 停止中に今と同じパターン番号が届いたときは、先読みデータで表示を上書きしない（本体から読む）
 *
 * v9：CC が届かない項目（フィルター種類、AMP EG、ミュート、IFX・Mod の種類など）を表示に反映する
 *     - 停止中は数秒おきに、今のパターンの本体データ（0x10）も読む。表示と違っていたときだけ表示を入れ替える
 *       （本体で LPF/HPF/BPF ボタンや Amp EG ボタンを押しても MIDI は何も届かないため）
 *     - 再生中は今までどおり読まない（停止したときにまとめて反映）
 *     - AMP EG のオン/オフ（パート内 +0x1A）を読む（表示だけ。CC がないので送信はできない）
 *
 * 画面側の使い方：
 *   E2.on(function (type, detail) { ... });   // 変化の通知
 *   E2.start();
 *   E2.state.parts[1..16].level など / E2.state.global / E2.state.program / E2.state.source
 *   E2.setPart(3, "mfxSend", 1); E2.setAllParts("mfxSend", 0); E2.setPad(x, y, touch);
 *   E2.reloadNow();                 // 今のパターンを読み直す（再生中でも実行する）
 *   E2.fetchStored(0, 249);         // 保存済みパターンの先読み（停止中のみ進む）
 *   E2.cancelFetch();
 *
 * 通知（type）：
 *   "status"  接続・再生・切替予約・先読みの状態が変わった
 *   "loaded"  状態が丸ごと入れ替わった（ダンプ or 先読みデータ）
 *   "part"    1パートの1項目が変わった  {part, field, value, source:"e2"|"app"}
 *   "verify"  照合結果 {mismatches:[...], checked:n}
 *   "cache"   先読みの進み具合 {done, total, count}
 *   "midi"    記録用の文字列 / "error" エラーの文字列
 *
 * iOS 12 の古い JavaScript でも動くように、var と function だけで書いています。
 */
(function (global) {
  "use strict";

  // ---------------- 定数 ----------------
  var PRODUCT_ID = 0x24;          // hacktribe = 0x24 / 標準 e2 = 0x23（実機確認済み：0x24）
  var PART_BASE = 0x800, PART_LEN = 0x330, DUMP_SIZE = 0x4000;

  var FIELDS = {
    mute:        { off: 0x01, kind: "r" },
    voiceAssign: { off: 0x02, kind: "r" },
    oscType:     { off: 0x08, kind: "r16" },
    oscEdit:     { off: 0x0B, kind: "u", cc: 82 },
    filterType:  { off: 0x0C, kind: "r" },
    cutoff:      { off: 0x0D, kind: "u", cc: 74 },
    reso:        { off: 0x0E, kind: "u", cc: 71 },
    filterEG:    { off: 0x0F, kind: "s", cc: 83 },
    modType:     { off: 0x10, kind: "r" },
    modSpeed:    { off: 0x11, kind: "u", cc: 86 },
    modDepth:    { off: 0x12, kind: "u", cc: 85 },
    attack:      { off: 0x14, kind: "u", cc: 73 },
    decay:       { off: 0x15, kind: "u", cc: 72 },
    level:       { off: 0x18, kind: "u", cc: 7 },
    pan:         { off: 0x19, kind: "s", cc: 10 },
    ampEG:       { off: 0x1A, kind: "b" },              // Amp EG ボタン（CC なし。表示だけ）
    mfxSend:     { off: 0x1B, kind: "b", cc: 105 },
    ifxOn:       { off: 0x20, kind: "b", cc: 104 },
    ifxType:     { off: 0x21, kind: "r" },
    ifxEdit:     { off: 0x22, kind: "u", cc: 87 },
    pitch:       { off: 0x24, kind: "s", cc: 80 },
    glide:       { off: 0x25, kind: "u", cc: 81 }
  };
  var CC_TO_FIELD = {};
  (function () { for (var f in FIELDS) if (FIELDS[f].cc) CC_TO_FIELD[FIELDS[f].cc] = f; })();

  var MFX_TYPES = ['Mod Delay','Tape Delay','High Pass Delay','Hall Reverb','Room Reverb','Wet Reverb','Looper','Pitch Looper','Step Shifter','Slicer','Jag Filter','Grain Shifter','Vinyl Break','Seq Reverse','Seq Doubler','Odd Stepper','Even Stepper','Low Pass Filter','High Pass Filter','Band Plus Filter','Touch Wah','Tube EQ','Decimator','Distortion','Compressor','Limiter','Chorus','XY Flanger','LFO Flanger','XY Phaser','LFO Phaser','Auto Pan'];
  var FILTER_TYPES = ['OFF','electribe LPF','MS20 LPF','MG LPF','P5 LPF','OB LPF','Acid LPF','electribe HPF','MS20 HPF','P5 HPF','OB HPF','Acid HPF','electribe BPF','MS20 BPF','P5 BPF','OB BPF','Acid BPF'];

  // ---------------- 状態 ----------------
  var state = {
    loaded: false,
    loadedAt: null,
    global: {},
    parts: [],
    program: null,          // 今のパターン番号（0始まり。プログラムチェンジを受けるまでは不明 = null）
    source: "",             // 表示の出どころ："本体" / "保存データ" / "未読込"
    reason: "",
    loadMs: 0
  };
  var status = {
    midi: "starting",
    inNames: [],
    outName: "",
    busy: false,            // ダンプ受信中
    playing: null,          // true / false / null（不明）
    pendingPattern: null,   // 切替予約中のパターン番号
    pendingAt: null,        // 予約したパターンへの切替予定時刻（Date.now() の値）
    fetching: null          // 先読み中 {done, total} / なし null
  };
  var options = {
    globalCh: 1,
    verifyAfterEdit: true,
    verifyDelay: 1500,
    verifyMinInterval: 3000,
    maxRetries: 3,               // 停止中の読み込み失敗時の読み直し回数
    retryInterval: 300,
    dumpWhilePlaying: false,     // true にすると、先読みがないとき再生中でも読みに行く（音切れの危険あり）
    idleRefreshMs: 8000,         // 停止中、今のパターンの保存データを確かめる間隔（0 で確かめない）
    idleCurrentMs: 4000          // 停止中、今のパターンの本体データを確かめる間隔（0 で確かめない）。CC が届かない項目の反映用
  };

  // ---------------- 通知 ----------------
  var listeners = [];
  function on(fn) { listeners.push(fn); }
  function emit(type, detail) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](type, detail); } catch (e) { if (global.console) console.log(e); }
    }
  }

  // ---------------- 小物 ----------------
  var t0 = Date.now();
  function ts() { return ((Date.now() - t0) / 1000).toFixed(2) + "s"; }
  function hex2(n) { var s = n.toString(16).toUpperCase(); return s.length < 2 ? "0" + s : s; }
  function hexArr(a, max) {
    var out = [], n = Math.min(a.length, max || a.length);
    for (var i = 0; i < n; i++) out.push(hex2(a[i]));
    if (a.length > n) out.push("…");
    return out.join(" ");
  }
  function sbyte(b) { return b > 127 ? b - 256 : b; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function toList(m) {
    var a = [];
    if (!m) return a;
    if (typeof m === "function") m = m();
    if (m.forEach) { m.forEach(function (p) { a.push(p); }); return a; }
    if (m.length !== undefined) { for (var i = 0; i < m.length; i++) a.push(m[i]); }
    return a;
  }
  function ccToValue(field, cc) {
    var k = FIELDS[field].kind;
    if (k === "b") return cc > 0 ? 1 : 0;
    if (k === "s") return cc - 64;
    return cc;
  }
  function valueToCc(field, v) {
    var k = FIELDS[field].kind;
    if (k === "b") return v ? 127 : 0;
    if (k === "s") return clamp(v + 64, 0, 127);
    return clamp(v, 0, 127);
  }
  function patName(n) { return n === null || n === undefined ? "?" : String(n + 1); }

  // ---------------- 接続層 ----------------
  var midi = null, inputs = [], outputs = [], outIndex = -1;

  function start() {
    if (!global.navigator || !navigator.requestMIDIAccess) {
      status.midi = "unsupported"; emit("status", status); return;
    }
    loadSaved();
    navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
      midi = access;
      status.midi = "ready";
      refreshPorts();
      midi.onstatechange = function () { refreshPorts(); };
      // 少し様子を見て、発音が流れてきていれば「再生中」とみなして読み込みを保留する
      setTimeout(function () {
        if (status.playing === null && Date.now() - lastNoteAt < 800) {
          status.playing = true;
          state.source = "未読込";
          emit("midi", ts() + " 起動時すでに再生中のようです。停止したら読み込みます");
          emit("status", status);
        }
        enqueue({ kind: "current", reason: "起動" });
      }, 800);
      setInterval(idleTick, 1000);
    }, function (err) {
      status.midi = "denied";
      emit("error", "MIDI を使えませんでした：" + err);
      emit("status", status);
    });
  }

  function refreshPorts() {
    inputs = toList(midi.inputs);
    outputs = toList(midi.outputs);
    status.inNames = [];
    for (var i = 0; i < inputs.length; i++) {
      status.inNames.push(inputs[i].name);
      inputs[i].onmidimessage = onMessage;
    }
    var keep = (outIndex >= 0 && outputs[outIndex] && outputs[outIndex].name === status.outName);
    if (!keep) {
      outIndex = -1;
      for (var j = 0; j < outputs.length; j++) {
        if (/SOUND|electribe/i.test(outputs[j].name)) { outIndex = j; break; }
      }
      if (outIndex < 0 && outputs.length) outIndex = 0;
    }
    status.outName = outIndex >= 0 ? outputs[outIndex].name : "";
    emit("status", status);
  }
  function send(arr) {
    if (outIndex < 0 || !outputs[outIndex]) { emit("error", "出力ポートがありません"); return false; }
    try { outputs[outIndex].send(arr); return true; }
    catch (e) { emit("error", "送信エラー：" + e); return false; }
  }

  // ---------------- 受信（1バイトずつ解釈） ----------------
  var sx = null, cm = null;
  var lastNoteAt = 0;

  function onMessage(ev) {
    var d = ev.data;
    if (d.length && d[0] < 0x80 && !(sx && sx.active)) return;   // ステータスのない断片は捨てる
    for (var i = 0; i < d.length; i++) feed(d[i]);
  }
  function feed(b) {
    if (b >= 0xF8) {
      if (b === 0xFA) onPlay(true);
      else if (b === 0xFB) onPlay(false);
      else if (b === 0xFC) onStop();
      return;
    }
    if (b === 0xF0) {
      if (sx && sx.active) { sx.active = false; jobFailed("次の SysEx が始まった"); }
      cm = null;
      sx = { active: true, bytes: [0xF0] };
      return;
    }
    if (b === 0xF7) {
      if (sx && sx.active) { sx.bytes.push(b); sx.active = false; onSysex(sx.bytes); }
      return;
    }
    if (b >= 0x80) {
      if (sx && sx.active) { sx.active = false; jobFailed("途中に別のメッセージ"); }
      var t = b & 0xF0;
      cm = { bytes: [b], need: (t === 0xC0 || t === 0xD0) ? 2 : 3 };
      return;
    }
    if (sx && sx.active) { sx.bytes.push(b); return; }
    if (cm) {
      cm.bytes.push(b);
      if (cm.bytes.length === cm.need) { handleChannel(cm.bytes); cm = { bytes: [cm.bytes[0]], need: cm.need }; }
    }
  }

  var bankMsb = 0, bankLsb = 0;
  function handleChannel(m) {
    var type = m[0] & 0xF0, ch = (m[0] & 0x0F) + 1;
    if (type === 0x90 || type === 0x80) { lastNoteAt = Date.now(); return; }
    if (type === 0xB0) {
      if (ch === options.globalCh && m[1] === 0) { bankMsb = m[2]; return; }
      if (ch === options.globalCh && m[1] === 32) { bankLsb = m[2]; return; }
      emit("midi", ts() + " 受信 ch" + ch + " CC#" + m[1] + " = " + m[2]);
      var f = CC_TO_FIELD[m[1]];
      if (f) noteCc(ch, f, m[2]);
      if (f && state.loaded) applyPart(ch, f, ccToValue(f, m[2]), "e2");
    } else if (type === 0xC0) {
      var n = (bankMsb * 128 + bankLsb) * 128 + m[1];
      onProgramChange(n);
    }
  }

  var ccHist = {};
  function noteCc(p, f, v) {
    var k = p + ":" + f, h = ccHist[k] || (ccHist[k] = []);
    h.push(ts() + "=" + v);
    if (h.length > 5) h.shift();
  }

  // ---------------- 再生・停止 ----------------
  var loopStart = null;       // 今のループが始まった時刻（分かるときだけ）
  function onPlay(fromStart) {
    loopStart = fromStart ? Date.now() : null;
    if (status.playing !== true) {
      status.playing = true;
      cancelVerify();
      emit("midi", ts() + (fromStart ? " 再生開始" : " 再生再開（途中から）"));
      emit("status", status);
    }
  }
  function onStop() {
    loopStart = null;
    var wasPending = status.pendingPattern !== null;
    clearSwitchTimer();
    if (status.playing !== false) {
      status.playing = false;
      emit("midi", ts() + " 停止" + (wasPending ? "（切替予約中に停止）" : ""));
      emit("status", status);
    }
    // 停止したら1回読み直して、表示が正しかったか確かめる
    enqueue({ kind: "current", reason: "停止時の確認", check: true });
    // 再生中に本体で保存していた場合に備えて、今のパターンの保存データも読み直す（先読みデータを新しくする）
    if (state.program !== null) refreshStored(state.program, "停止時の確認");
    pumpQueue();
  }
  function isPlaying() { return status.playing === true; }

  // ---------------- パターン切替 ----------------
  var switchTimer = null;
  function clearSwitchTimer() {
    if (switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
    status.pendingPattern = null;
    status.pendingAt = null;
  }
  // パターン1周の長さ（ミリ秒）。1小節 = 16ステップ
  function patternMs(g) {
    if (!g || !g.tempo) return 0;
    var div = [4, 8, 3, 6][g.beat] || 4;
    return Math.round((g.lengthBars || 4) * 16 * (60000 / g.tempo) / div);
  }
  function predictSwitch() {
    var dur = patternMs(state.global);
    if (loopStart === null || !dur) return null;
    var now = Date.now();
    return loopStart + Math.ceil((now - loopStart) / dur) * dur;
  }

  function onProgramChange(n) {
    cancelVerify();
    if (!isPlaying()) {
      // 停止中：e2 はすぐ切り替わる
      var old = state.program, same = (n === old && state.source === "本体");
      emit("midi", ts() + " パターン " + patName(n) + " に切替（停止中）" + (same ? "（今と同じ番号なので、先読みデータは使わず本体から読みます）" : ""));
      clearSwitchTimer();
      state.program = n;
      if (!same && cache[n]) loadData(cache[n], "保存データ", "パターン切替（先読み）", 0, true);
      // 切り替えた直後の本体データは保存データと同じなので、それで先読みデータを新しくする（同じ番号のときは除く）
      enqueue({ kind: "current", reason: "パターン切替", check: !same && !!cache[n], storedOf: same ? undefined : n });
      // 切替前のパターンは、停止中に保存してから切り替えた可能性があるので、保存データを読み直す
      if (old !== null && old !== n) refreshStored(old, "切替前のパターン");
      return;
    }
    // 再生中：ループの区切りで切り替わる。e2 には何も要求しない
    var now = Date.now();
    var predicted = predictSwitch();
    var dur = patternMs(state.global) || 8000;
    var when = predicted !== null ? predicted : now + dur;      // 予測できないときは「遅くともここまでに」で切り替える
    if (switchTimer) clearTimeout(switchTimer);
    status.pendingPattern = n;
    status.pendingAt = when;
    emit("midi", ts() + " パターン " + patName(n) + " を予約（" +
      (predicted !== null ? "切替予定 " + ((when - now) / 1000).toFixed(2) + "s 後" : "切替時刻不明のため " + (dur / 1000).toFixed(1) + "s 後に表示を切替") +
      "、" + (cache[n] ? "先読みデータあり" : "先読みデータなし") + "）");
    emit("status", status);
    switchTimer = setTimeout(function () {
      switchTimer = null;
      doSwitch(n, when, predicted !== null);
    }, Math.max(when - now, 0));
  }
  function doSwitch(n, when, exact) {
    status.pendingPattern = null;
    status.pendingAt = null;
    state.program = n;
    loopStart = exact ? when : null;
    if (cache[n]) {
      loadData(cache[n], "保存データ", exact ? "切替（予測時刻）" : "切替（推定）", 0, true);
    } else if (options.dumpWhilePlaying) {
      enqueue({ kind: "current", reason: "切替（再生中に読込）", force: true });
    } else {
      state.source = "未読込";
      verifyQueue = {}; lastData = null; touched = {};     // 切替前の内容とは比べない
      emit("midi", ts() + " パターン " + patName(n) + " の先読みデータがないため、表示は停止まで保留");
      emit("loaded", state);
    }
    emit("status", status);
  }

  // ---------------- 読み込みの順番待ち ----------------
  //   job = { kind:"current"|"stored", index, reason, check, force, tries, refresh, quiet, idle, storedOf, tq }
  //     refresh：先読みデータを新しくするための読み直し（先読みの進み具合には数えない）
  //     idle：停止中の定期確認（今のパターン）。表示と同じなら何もしない。失敗しても読み直さない
  //     storedOf：切替直後の本体データ。読めたらそのパターンの先読みデータを新しくする
  var queue = [], job = null, jobTimer = null, retryTimer = null;
  var fetchTotal = 0, fetchDone = 0, fetchT0 = 0;

  function enqueue(j) {
    j.tq = j.tq || Date.now();
    if (j.kind === "current") {
      // 同じ「今のパターン」の読み込みが待っていれば1つにまとめる
      for (var i = 0; i < queue.length; i++) if (queue[i].kind === "current") {
        queue[i].reason = j.reason; queue[i].check = queue[i].check || j.check; queue[i].force = queue[i].force || j.force;
        queue[i].quiet = queue[i].quiet && j.quiet; queue[i].idle = queue[i].idle && j.idle;
        if (j.storedOf !== undefined) queue[i].storedOf = j.storedOf;
        pumpQueue(); return;
      }
      queue.unshift(j);      // 今のパターンは先読みより優先
    } else if (j.refresh) {
      for (var k = 0; k < queue.length; k++) if (queue[k].refresh && queue[k].index === j.index) { pumpQueue(); return; }
      var at = 0;
      while (at < queue.length && queue[at].kind === "current") at++;
      queue.splice(at, 0, j);  // 今のパターンの次に（先読みより優先）
    } else queue.push(j);
    pumpQueue();
  }
  function refreshStored(index, reason) {
    enqueue({ kind: "stored", index: index, reason: reason, refresh: true, quiet: true });
  }
  function pumpQueue() {
    if (job || retryTimer || status.midi !== "ready") return;
    if (!queue.length) return;
    // 再生中は、強制（手動など）以外は進めない
    if (isPlaying() && !queue[0].force) {
      if (status.fetching) emit("status", status);
      return;
    }
    job = queue.shift();
    job.tries = job.tries || 0;
    startJob();
  }
  function startJob() {
    var msg;
    if (job.kind === "stored") msg = [0xF0, 0x42, 0x30 + options.globalCh - 1, 0x00, 0x01, PRODUCT_ID, 0x1C, job.index % 128, Math.floor(job.index / 128), 0xF7];
    else msg = [0xF0, 0x42, 0x30 + options.globalCh - 1, 0x00, 0x01, PRODUCT_ID, 0x10, 0xF7];
    job.t0 = Date.now();
    if (job.kind === "stored" && !job.refresh && !fetchT0) fetchT0 = job.t0;
    job.playing = isPlaying();
    if (!send(msg)) { job = null; return; }
    if (!job.quiet) { status.busy = true; emit("status", status); }
    jobTimer = setTimeout(function () { jobTimer = null; jobFailed("応答なし"); }, 4000);
  }
  function jobFailed(why) {
    if (!job) return;
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
    var j = job;
    job = null;
    status.busy = false;
    if (j.idle) {                            // 定期確認は読み直さない（次の回に任せる）
      emit("midi", ts() + " 停止中の定期確認（今のパターン）の読み込み失敗（" + why + "）");
      pumpQueue();
      emit("status", status);
      return;
    }
    if (isPlaying() && !j.force) {          // 再生が始まった：数えずに順番待ちへ戻し、停止を待つ
      queue.unshift(j);
      emit("status", status);
      return;
    }
    j.tries++;
    var label = j.kind === "stored" ? "保存パターン " + patName(j.index) + (j.refresh ? "（" + j.reason + "）" : "") : "今のパターン（" + j.reason + "）";
    if (j.tries <= options.maxRetries) {
      emit("midi", ts() + " " + label + " の読み込み失敗（" + why + "）。読み直します");
      queue.unshift(j);
      retryTimer = setTimeout(function () { retryTimer = null; pumpQueue(); }, options.retryInterval);
    } else {
      emit("error", ts() + " " + label + " を読み込めませんでした（" + why + "）");
      if (j.kind === "stored" && !j.refresh) stepFetch();
      pumpQueue();
    }
    emit("status", status);
  }
  function jobDone() {
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
    job = null;
    status.busy = false;
    emit("status", status);
    pumpQueue();
  }

  function onSysex(b) {
    var korg = b[0] === 0xF0 && b[1] === 0x42 && b[4] === 0x01;
    if (!korg || !job) { emit("midi", ts() + " 受信 SysEx: " + hexArr(b, 12)); return; }
    var func = b[6];
    if (func === 0x24 || func === 0x26) { jobFailed("e2 がエラー応答 0x" + hex2(func)); return; }
    var data;
    if (func === 0x40 && job.kind === "current") data = decode7(b.slice(7, b.length - 1));
    else if (func === 0x4C && job.kind === "stored") {
      var idx = b[7] + 128 * b[8];
      if (idx !== job.index) emit("midi", ts() + " 注意：要求 " + patName(job.index) + " に対して " + patName(idx) + " が返ってきた");
      data = decode7(b.slice(9, b.length - 1));
    } else { jobFailed("想定外の応答 0x" + hex2(func)); return; }
    if (data.length !== DUMP_SIZE) { jobFailed("不完全 " + b.length + " バイト"); return; }

    var j = job, ms = Date.now() - j.t0;
    if (j.kind === "stored") {
      // 今のパターンを本体から読んだデータがあれば、保存データと比べておく（番号指定の読み込みが正しいかの確認）
      if (state.program === null && currentRaw && state.source === "本体") {
        var same = true;
        for (var r = 0; r < DUMP_SIZE; r++) if (currentRaw[r] !== data[r]) { same = false; break; }
        if (same) {
          state.program = j.index;
          emit("midi", ts() + " 今のパターンは " + patName(j.index) + " と推定（保存データと完全に一致）");
          emit("loaded", state);
        }
      } else if (!j.refresh && j.index === state.program && currentRaw && state.source === "本体") {
        var diff = 0;
        for (var q = 0; q < DUMP_SIZE; q++) if (currentRaw[q] !== data[q]) diff++;
        emit("midi", ts() + " 確認：保存パターン " + patName(j.index) + " と今のパターンの差 " + diff + " バイト" + (diff ? "（保存していない編集があれば差が出ます）" : "（一致）"));
      }
      if (j.refresh) {
        lastRefreshAt = Date.now();
        var changed = updateStored(j.index, data, j.reason);
        // 表示が古い先読みデータのままなら、新しいほうに直す
        if (changed && j.index === state.program && state.source === "保存データ" && !isPlaying())
          loadData(cache[j.index], "保存データ", "先読みデータの更新", 0, true);
      } else {
        cache[j.index] = toBytes(data);
        cacheCount = countCache();
        saveOne(j.index, cache[j.index]);
        stepFetch(j.index, data);
      }
    } else {
      // 停止中の定期確認：表示の元のデータと同じなら何もしない（再描画しない）
      if (j.idle && lastData && state.source === "本体" && sameData(data, lastData)) { currentRaw = data; jobDone(); return; }
      if (j.idle) emit("midi", ts() + " 停止中の定期確認：本体の値が変わっていたので表示を直します（CC が届かない項目：フィルター種類・AMP EG・ミュートなど）");
      currentRaw = data;
      loadData(data, "本体", j.reason, ms, false, j.check);
      // 停止中にパターンを切り替えた直後の本体データ＝保存データ。その後に操作していなければ先読みデータを新しくする
      if (j.storedOf !== undefined && j.storedOf === state.program && !j.playing && !isPlaying() && lastEditAt < j.tq)
        updateStored(j.storedOf, data, "切替直後の本体データ");
    }
    jobDone();
  }
  function sameData(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function decode7(src) {
    var out = [];
    for (var i = 0; i < src.length; i += 8) {
      var msb = src[i];
      for (var j = 0; j < 7 && i + 1 + j < src.length; j++) out.push(src[i + 1 + j] | (((msb >> j) & 1) << 7));
    }
    return out;
  }
  function toBytes(a) {
    var u = global.Uint8Array ? new Uint8Array(a.length) : [];
    for (var i = 0; i < a.length; i++) u[i] = a[i];
    return u;
  }

  // ---------------- 先読み ----------------
  var cache = {}, cacheCount = 0, currentRaw = null;
  function countCache() { var n = 0; for (var k in cache) n++; return n; }

  // 先読みデータを新しいデータに入れ替える（違っていたときだけ）。入れ替えたら true
  var lastRefreshAt = 0, lastEditAt = 0, lastIdleCurrentAt = 0;
  function updateStored(index, data, why) {
    var old = cache[index], diff = 0;
    if (old) {
      for (var i = 0; i < DUMP_SIZE; i++) if (old[i] !== data[i]) diff++;
      if (!diff) return false;
    }
    cache[index] = toBytes(data);
    cacheCount = countCache();
    saveOne(index, cache[index]);
    emit("midi", ts() + " パターン " + patName(index) + " の先読みデータを" + (old ? "更新（本体で保存し直されていた。差 " + diff + " バイト、" : "新しく保存（") + why + "）");
    emit("cache", { done: 0, total: 0, count: cacheCount });
    return true;
  }
  // 停止中に毎秒呼ばれる：
  //   ・数秒おきに今のパターンの本体データを読む（本体で押したフィルター種類・AMP EG などは CC が届かないため）
  //   ・数秒おきに今のパターンの保存データを確かめる（停止中に本体で保存した場合に、先読みデータを新しくする）
  function idleTick() {
    if (status.midi !== "ready" || !status.outName) return;
    if (status.playing === true || Date.now() - lastNoteAt < 1500) return;       // 再生中（またはその疑い）は読まない
    if (job || retryTimer || queue.length) return;
    var now = Date.now();
    if (now - lastEditAt < 2000) return;                                         // つまみを回している最中は読まない
    var lastLoad = state.loadedAt ? state.loadedAt.getTime() : 0;
    if (options.idleCurrentMs && state.loaded && now - lastIdleCurrentAt >= options.idleCurrentMs && now - lastLoad >= options.idleCurrentMs) {
      lastIdleCurrentAt = now;
      enqueue({ kind: "current", reason: "停止中の定期確認", quiet: true, idle: true });
      return;
    }
    if (options.idleRefreshMs && state.program !== null && now - lastRefreshAt >= options.idleRefreshMs) {
      lastRefreshAt = now;
      refreshStored(state.program, "停止中の定期確認");
    }
  }

  // ---------------- iPad への保存（次回から先読み不要にする） ----------------
  // パターンデータは大部分が 0 なので、0 の連続を縮めてから文字列にして localStorage に入れる
  var KEY = "e2pat2:";            // 形式を変えたときは番号を上げる（2 = 初期パターンとの差分を保存）
  // e2 の初期パターン（e2-scripts の init.e2pat の 0x100 以降）。これとの差分だけを保存して容量を減らす
  var INIT_PACKED = "\u0250\u0254\u0253\u0254\u0100\u010c\u0249\u026e\u0275\u0274\u0100\u010e\u02d8\u0204\u0100\u0104\u0209\u0203\u0100\u0107\u0201\u0100\u010b\u0203\u0270\u026e\u0201\u0100\u0103\u0201\u0201\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u01c4\u0201\u0201\u0100\u0103\u0263\u0202\u0100\u0103\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u0209\u0202\u0100\u0103\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u02f3\u0100\u0104\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0201\u0100\u0102\u0255\u0100\u0104\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0201\u0100\u0107\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0201\u0100\u0107\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0201\u0100\u0107\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0201\u0100\u0107\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u0212\u0100\u0104\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u0214\u0100\u0104\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u0279\u0100\u0104\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u02c3\u0100\u0104\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u021e\u0201\u0100\u0103\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u0271\u0201\u0100\u0103\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u029e\u0201\u0100\u0103\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010c\u0201\u0201\u0100\u0103\u024b\u0202\u0100\u0103\u027f\u0100\u0103\u0221\u0100\u0103\u027f\u0100\u0102\u0264\u0100\u0109\u0214\u0100\u010e\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u010a\u0248\u0260\u0100\u01ff\u0100\u0106\u0250\u0254\u0245\u0244\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u01ff\u0100\u0104";
  var REF = null;
  function ref() { if (!REF) REF = unpackRaw(INIT_PACKED); return REF; }
  function xorRef(u) { var r = ref(), o = new Uint8Array(DUMP_SIZE); for (var i = 0; i < DUMP_SIZE; i++) o[i] = u[i] ^ r[i]; return o; }
  var saveOk = null;              // 保存が使えるか（null=未確認）
  var savedInfo = { count: 0, chars: 0, at: null };
  function packData(u) { return packRaw(xorRef(u)); }
  function unpackData(str) { return xorRef(unpackRaw(str)); }
  function packRaw(u) {
    var out = [], i = 0;
    while (i < u.length) {
      if (u[i] === 0) {
        var n = 0;
        while (i < u.length && u[i] === 0 && n < 255) { n++; i++; }
        out.push(String.fromCharCode(0x100, 0x100 + n));
      } else { out.push(String.fromCharCode(0x200 + u[i])); i++; }
    }
    return out.join("");
  }
  function unpackRaw(str) {
    var u = new Uint8Array(DUMP_SIZE), k = 0;
    for (var i = 0; i < str.length && k < DUMP_SIZE; i++) {
      var c = str.charCodeAt(i);
      if (c === 0x100) { k += str.charCodeAt(++i) - 0x100; }
      else u[k++] = c - 0x200;
    }
    return u;
  }
  function storage() { try { return global.localStorage || null; } catch (e) { return null; } }
  function saveOne(index, u) {
    var ls = storage();
    if (!ls) { if (saveOk !== false) { saveOk = false; emit("midi", ts() + " この環境では iPad への保存が使えません（先読みはページを開いている間だけ有効）"); } return; }
    try {
      ls.setItem(KEY + index, packData(u));
      ls.setItem(KEY + "at", String(Date.now()));
      saveOk = true;
    } catch (e) {
      if (saveOk !== false) emit("error", ts() + " iPad への保存に失敗（容量不足など）：" + e);
      saveOk = false;
    }
  }
  function loadSaved() {
    var ls = storage(), n = 0, chars = 0;
    if (!ls) return;
    try {
      for (var i = 0; i < 250; i++) {
        var v = ls.getItem(KEY + i);
        if (v) { cache[i] = unpackData(v); n++; chars += v.length; }
      }
      var at = ls.getItem(KEY + "at");
      savedInfo = { count: n, chars: chars, at: at ? new Date(parseInt(at, 10)) : null };
      cacheCount = countCache();
      if (n) emit("midi", ts() + " iPad に保存してあった先読みデータを読み込み：" + n + " パターン（約 " + Math.round(chars * 2 / 1024) + " KB、最終更新 " + (savedInfo.at ? savedInfo.at.toLocaleString() : "不明") + "）");
      emit("cache", { done: 0, total: 0, count: cacheCount, saved: savedInfo });
    } catch (e) { emit("error", ts() + " 保存データの読み込みに失敗：" + e); }
  }
  function clearSaved() {
    var ls = storage();
    cache = {}; cacheCount = 0;
    if (ls) { try { for (var i = 0; i < 250; i++) ls.removeItem(KEY + i); ls.removeItem(KEY + "at"); } catch (e) {} }
    savedInfo = { count: 0, chars: 0, at: null };
    emit("midi", ts() + " 先読みデータと iPad の保存を消しました");
    emit("cache", { done: 0, total: 0, count: 0, saved: savedInfo });
  }
  function fetchStored(from, to) {
    from = clamp(from | 0, 0, 249); to = clamp(to | 0, 0, 249);
    fetchTotal = to - from + 1; fetchDone = 0; fetchT0 = 0;
    for (var i = from; i <= to; i++) enqueue({ kind: "stored", index: i, reason: "先読み" });
    status.fetching = { done: 0, total: fetchTotal };
    emit("status", status);
    emit("midi", ts() + " 保存パターン " + (from + 1) + "〜" + (to + 1) + " の先読みを開始" + (isPlaying() ? "（再生中のため停止まで待ちます）" : ""));
  }
  function stepFetch(index, data) {
    fetchDone++;
    var name = "";
    if (data) { for (var i = 0x10; i < 0x22; i++) { if (!data[i]) break; name += String.fromCharCode(data[i]); } }
    status.fetching = fetchDone < fetchTotal ? { done: fetchDone, total: fetchTotal } : null;
    emit("cache", { done: fetchDone, total: fetchTotal, count: cacheCount, index: index, name: name.replace(/\s+$/, ""),
                    elapsed: fetchT0 ? (Date.now() - fetchT0) / 1000 : 0, saveOk: saveOk });
    if (!status.fetching) emit("midi", ts() + " 先読み完了（" + cacheCount + " パターン、" + ((Date.now() - fetchT0) / 1000).toFixed(1) + " 秒" + (saveOk ? "、iPad に保存済み" : (saveOk === false ? "、iPad への保存は不可" : "")) + "）");
    emit("status", status);
  }
  function cancelFetch() {
    var keep = [];
    for (var i = 0; i < queue.length; i++) if (queue[i].kind !== "stored" || queue[i].refresh) keep.push(queue[i]);
    queue = keep;
    status.fetching = null;
    emit("midi", ts() + " 先読みを中止（" + cacheCount + " パターン読込済み）");
    emit("status", status);
  }

  // ---------------- 状態の読み込み ----------------
  var lastData = null;     // 表示の元になったデータ
  var touched = {};        // その後 CC で変わったはずのバイト位置
  var verifyQueue = {}, verifyTimer = null;

  function readPart(data, p) {
    var base = PART_BASE + PART_LEN * (p - 1), o = {};
    for (var f in FIELDS) {
      var F = FIELDS[f], raw = data[base + F.off];
      if (F.kind === "s") o[f] = sbyte(raw);
      else if (F.kind === "b") o[f] = raw ? 1 : 0;
      else if (F.kind === "r16") o[f] = raw + 256 * data[base + F.off + 1];
      else o[f] = raw;
    }
    o.mute = o.mute ? 1 : 0;
    o.filterTypeName = FILTER_TYPES[o.filterType] || ("#" + o.filterType);
    return o;
  }
  function readGlobal(data) {
    var name = "";
    for (var i = 0x10; i < 0x22; i++) { if (!data[i]) break; name += String.fromCharCode(data[i]); }
    return {
      name: name.replace(/\s+$/, ""),
      tempo: (data[0x22] + 256 * data[0x23]) / 10,
      mfxType: data[0x3D],
      mfxTypeName: MFX_TYPES[data[0x3D]] || ("#" + data[0x3D]),
      padX: data[0x3E], padY: data[0x3F],
      mfxHold: data[0x41] ? 1 : 0,
      playLevel: 127 - data[0x2A],
      lengthBars: (data[0x25] & 3) + 1,
      beat: data[0x26] & 3
    };
  }

  // newPattern：パターンが替わった読み込み（照合しない）／ check：表示が正しかったかを確かめる
  function loadData(data, source, reason, ms, newPattern, check) {
    var g = readGlobal(data);
    var parts = [null];
    for (var p = 1; p <= 16; p++) parts.push(readPart(data, p));

    // 停止時などの確認：表示していたデータ（＋その後の CC）と、実際の値の差
    if (check && lastData) {
      var diff = 0;
      for (var o = 0; o < DUMP_SIZE; o++) if (data[o] !== lastData[o] && !touched[o]) diff++;
      emit("midi", ts() + " 確認（" + reason + "）：表示していた内容と本体の差 " + diff + " バイト" + (diff ? "（表示がずれていました。本体の値に直します）" : "（一致）"));
    }

    // 照合：操作で予測した値と実際の値を比べる
    var mismatches = [], checked = 0;
    if (!newPattern && state.loaded && source === "本体") {
      for (var key in verifyQueue) {
        var c = verifyQueue[key];
        checked++;
        var actual = parts[c.part][c.field];
        if (actual !== c.value) mismatches.push({ part: c.part, field: c.field, expected: c.value, actual: actual, cc: c.cc, source: c.source, history: (ccHist[c.part + ":" + c.field] || []).join(" ") });
      }
    }
    if (source === "本体" || newPattern) verifyQueue = {};

    lastData = data;
    touched = {};
    state.global = g;
    state.parts = parts;
    state.loaded = true;
    state.loadedAt = new Date();
    state.loadMs = ms;
    state.reason = reason;
    state.source = source;
    emit("midi", ts() + " 表示を更新（" + source + "・" + reason + (ms ? "、" + ms + "ms" : "") + "）パターン " + patName(state.program) + " 名前=" + g.name + " BPM=" + g.tempo);
    emit("loaded", state);
    if (checked) emit("verify", { mismatches: mismatches, checked: checked });
  }

  // ---------------- 操作の反映と照合 ----------------
  function applyPart(p, field, value, source) {
    if (!state.loaded || !state.parts[p]) return;
    lastEditAt = Date.now();
    touched[PART_BASE + PART_LEN * (p - 1) + FIELDS[field].off] = true;
    state.parts[p][field] = value;
    emit("part", { part: p, field: field, value: value, source: source });
    verifyQueue[p + ":" + field] = { part: p, field: field, value: value, cc: valueToCc(field, value), source: source };
    scheduleVerify();
  }
  function scheduleVerify() {
    if (!options.verifyAfterEdit || isPlaying()) return;     // 再生中はためておき、停止時の確認でまとめて照合
    if (verifyTimer) clearTimeout(verifyTimer);
    var wait = options.verifyDelay;
    var gap = state.loadedAt ? (state.loadedAt.getTime() + options.verifyMinInterval - Date.now()) : 0;
    if (gap > wait) wait = gap;
    verifyTimer = setTimeout(function () { verifyTimer = null; enqueue({ kind: "current", reason: "照合" }); }, wait);
  }
  function cancelVerify() { if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; } }

  function reloadNow() {
    if (isPlaying()) emit("midi", ts() + " 再生中の手動読み直し（音が乱れることがあります）");
    enqueue({ kind: "current", reason: "手動", force: true, check: true });
  }

  // ---------------- 送信 ----------------
  function setPart(p, field, value) {
    var F = FIELDS[field];
    if (!F || !F.cc) { emit("error", field + " は送信できない項目です"); return; }
    var cc = valueToCc(field, value);
    if (send([0xB0 + (p - 1), F.cc, cc])) {
      emit("midi", ts() + " 送信 ch" + p + " CC#" + F.cc + " = " + cc);
      applyPart(p, field, ccToValue(field, cc), "app");
    }
  }
  function setAllParts(field, value) { for (var p = 1; p <= 16; p++) setPart(p, field, value); }
  function setPad(x, y, touch) {
    var st = 0xB0 + (options.globalCh - 1);
    if (x !== null && x !== undefined) send([st, 102, clamp(x, 0, 127)]);
    if (y !== null && y !== undefined) send([st, 103, clamp(y, 0, 127)]);
    if (touch !== null && touch !== undefined) send([st, 106, touch ? 127 : 0]);
  }

  // ---------------- 公開 ----------------
  global.E2 = {
    version: "core-v9",
    FIELDS: FIELDS,
    state: state,
    status: status,
    options: options,
    on: on,
    start: start,
    reloadNow: reloadNow,
    fetchStored: fetchStored,
    cancelFetch: cancelFetch,
    clearSaved: clearSaved,
    _pack: packData, _unpack: unpackData,
    hasCache: function (n) { return !!cache[n]; },
    cacheCount: function () { return cacheCount; },
    setPart: setPart,
    setAllParts: setAllParts,
    setPad: setPad,
    patternMs: function () { return patternMs(state.global); },
    _decode7: decode7,
    _feed: feed, _onSysex: onSysex
  };
})(this);
