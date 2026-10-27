/** Host-authoritative WebRTC room transport. Only enableVoice() asks for microphone access. */
const API = '/api/arena/rooms';
const RTC_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }], iceCandidatePoolSize: 0 };
const noop = () => {};
const safeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function sid() { return crypto.randomUUID(); }
export class ArenaNetwork {
  constructor(options = {}) {
    this.onPeers = options.onPeers || noop; this.onInput = options.onInput || noop;
    this.onSnapshot = options.onSnapshot || noop; this.onStatus = options.onStatus || noop;
    this.onVoice = options.onVoice || noop; this.onMessage = options.onMessage || noop; this.onDiagnostics = options.onDiagnostics || noop;
    this.diagnosticCounts = {offerTx:0,answerTx:0,iceTx:0,offerRx:0,answerRx:0,iceRx:0,signalErrors:0,iceErrors:0,polls:0}; this.diagnosticErrors = [];
    this.voiceRadius = options.voiceRadius || 520;
    this.links = new Map(); this.members = []; this.positions = new Map(); this.pendingIce = new Map();
    this.selfId = ''; this.hostId = ''; this.roomCode = ''; this.token = ''; this.isHost = false;
    this.cursor = 0; this.inputSeq = 0; this.snapshotSeq = 0; this.lastSnapshotSeq = -1; this.timer = null; this.generation = 0; this.stream = null; this.audioContext = null;
    this.relayTimer = null; this.interpolationTimer = null; this.relayActive = false; this.relayPeers = new Set(); this.latestSnapshot = null; this.latestInput = null; this.enteredAt = 0; this.relaySamples = []; this.lastRelaySeq = 0;
    this.voiceEnabled = false; this.talking = false; this.muted = false; this.lastGoodPoll = 0;
    this._release = () => this.setTalking(false);
    globalThis.addEventListener?.('blur', this._release);
    globalThis.document?.addEventListener('visibilitychange', this._release);
  }
  _status(state, message) { this.onStatus({ state, message }); this._diagnose(); }
  getDiagnostics() {
    return {role:this.roomCode ? (this.isHost ? '房主' : '玩家') : '未连接', gameTransport:this.relayActive ? 'HTTPS兼容联机（高延迟；语音仍需WebRTC）' : 'WebRTC直连', counts:{...this.diagnosticCounts}, errors:[...this.diagnosticErrors], peers:[...this.links].map(([id,l])=>({name:this.members.find(p=>p.id===id)?.name || '玩家',connection:l.pc.connectionState,ice:l.pc.iceConnectionState,gathering:l.pc.iceGatheringState,signaling:l.pc.signalingState,data:l.channel?.readyState || '尚无数据通道',gameRelay:this.relayPeers.has(id),localCandidates:{...l.localCandidates},remoteCandidates:l.remoteCandidates || 0,localDescription:!!l.pc.localDescription,remoteDescription:!!l.pc.remoteDescription}))};
  }
  _diagnosticError(label,error) { this.diagnosticErrors.push(label + ': ' + (error?.name || error?.status || '失败')); this.diagnosticErrors=this.diagnosticErrors.slice(-5); this._diagnose(); }
  _diagnose() {
    const data=this.getDiagnostics(); this.onDiagnostics(data);
    if (!globalThis.document?.body || document.getElementById('connection-debug')) return;
    let details=document.getElementById('connection-diagnostics');
    if (!details) {
      details=document.createElement('details');details.id='connection-diagnostics';
      details.style.cssText='position:fixed;bottom:12px;right:12px;z-index:80;max-width:min(420px,90vw);background:#152322ee;color:#d6f2ed;border:1px solid #3d635d;border-radius:8px;padding:8px 10px;font:11px/1.5 monospace;';
      const summary=document.createElement('summary');summary.textContent='连接诊断';details.append(summary);
      const pre=document.createElement('pre');pre.style.cssText='white-space:pre-wrap;max-height:260px;overflow:auto;margin:7px 0 0';details.append(pre);document.body.append(details);
    }
    details.hidden=!this.roomCode;
    details.querySelector('pre').textContent=JSON.stringify(data,null,2);
  }
  _voice(extra = {}) { this.onVoice({ enabled:this.voiceEnabled, talking:this.talking, muted:this.muted, ...extra }); }
  async _fetch(path, {method = 'GET', data, authenticated = true, keepalive = false} = {}) {
    const headers = {};
    if (data !== undefined) headers['content-type'] = 'application/json';
    if (authenticated) { headers['x-arena-peer'] = this.selfId; headers.authorization = 'Bearer ' + this.token; }
    const response = await fetch(API + path, {method, headers, body:data === undefined ? undefined : JSON.stringify(data), cache:'no-store', credentials:'same-origin', keepalive, signal:keepalive ? undefined : AbortSignal.timeout(10000)});
    const result = await response.json().catch(() => ({error:'房间服务返回了无效响应。'}));
    if (!response.ok) { const error = new Error(result.error || '房间请求失败。'); error.status = response.status; throw error; }
    return result;
  }
  async createRoom(name = 'Rookie') { return this._enter('', name); }
  async joinRoom(code, name = 'Rookie') {
    code = String(code || '').toUpperCase().replace(/\s/g,'');
    if (!/^[A-Z2-9]{8}$/.test(code)) throw new Error('请输入八位房间码。');
    return this._enter(code, name);
  }
  async _enter(code, name) {
    if (!globalThis.RTCPeerConnection) throw new Error('此浏览器不支持 WebRTC，请使用最新版 Chrome、Safari 或 Firefox。');
    this.leave(); this.resumeAudio().catch(noop);
    const generation = this.generation;
    this._status('connecting', code ? '正在加入房间…' : '正在创建房间…');
    try {
      const data = await this._fetch(code ? '/' + code + '/join' : '', {method:'POST',data:{name},authenticated:false});
      if (generation !== this.generation) return null;
      this.selfId = data.selfId; this.hostId = data.hostId; this.isHost = this.selfId === this.hostId;
      this.roomCode = data.code; this.token = data.token; this.enteredAt = Date.now(); this.cursor = 0; this.lastGoodPoll = Date.now();
      this._syncMembers(data.peers); this._status('room', this.isHost ? '房间已准备好，可以把房间码发给朋友。' : '已加入房间，正在连接房主…');
      this._poll(generation); this._relay(generation);
      return {code:this.roomCode,selfId:this.selfId,hostId:this.hostId,isHost:this.isHost,peers:this.members};
    } catch (error) { this._status('error',error.message); throw error; }
  }
  _emitPeers() { this.onPeers(this.members.map(p=>({...p, connected:p.id===this.selfId || this.links.get(p.id)?.channel?.readyState==='open' || this.relayPeers.has(p.id),transport:this.links.get(p.id)?.channel?.readyState==='open' ? 'webrtc' : this.relayPeers.has(p.id) ? 'https' : 'connecting'}))); }
  _syncMembers(members) {
    this.members = Array.isArray(members) ? members.filter(p=>safeId(p.id)).map(p=>({id:p.id,name:String(p.name).slice(0,20)})) : [];
    const ids = new Set(this.members.map(p=>p.id));
    for (const id of this.links.keys()) if (!ids.has(id)) this._closeLink(id);
    for (const peer of this.members) {
      if (peer.id !== this.selfId && this.selfId < peer.id && !this.links.has(peer.id)) this._offer(peer.id).catch(error=>this._status('connection-error',error.message));
    }
    this._emitPeers();
  }
  async _poll(generation) {
    if (generation !== this.generation || !this.roomCode) return;
    try {
      const data = await this._fetch('/' + this.roomCode + '/poll?after=' + this.cursor);
      if (generation !== this.generation) return;
      this.lastGoodPoll = Date.now(); this.diagnosticCounts.polls++; this._syncMembers(data.peers);
      for (const signal of data.signals || []) {
        this.cursor = Math.max(this.cursor, signal.id);
        if (!this.members.some(p=>p.id===signal.sender)) continue;
        try { await this._signal(signal); } catch (error) { this._status('connection-error','有一位玩家的连接需要重试：' + error.message); }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if ([401,410].includes(error.status) || Date.now() - this.lastGoodPoll > 45000) {
        const message = error.status === 410 ? error.message : '房间连接已过期，请重新加入。';
        this.leave(false); this._status('ended',message); return;
      }
      this._status('reconnecting','房间连接暂时中断，正在重试…');
    }
    this._diagnose();
    if (generation === this.generation && this.roomCode) this.timer = setTimeout(()=>this._poll(generation),1000);
  }
  _needsRelay() {
    if (!this.roomCode || Date.now()-this.enteredAt < 10000) return false;
    if (!this.isHost) return this.links.get(this.hostId)?.channel?.readyState !== 'open';
    return this.members.some(p=>p.id!==this.selfId && this.links.get(p.id)?.channel?.readyState !== 'open');
  }
  async _relay(generation) {
    if (generation !== this.generation || !this.roomCode) return;
    if (this._needsRelay()) {
      if (!this.relayActive) {this.relayActive=true;this._status('relay','兼容联机已启用 · 高延迟。语音仍需直连，未连通时不可用。');}
      try {
        const payload=this.isHost ? (this.latestSnapshot ? {snapshot:this.latestSnapshot,seq:this.snapshotSeq} : {}) : (this.latestInput ? {input:this.latestInput,seq:this.inputSeq} : {});
        const result=await this._fetch('/'+this.roomCode+'/exchange',{method:'POST',data:payload});
        if (generation !== this.generation) return;
        if (this.isHost) {
          for (const peer of result.inputs || []) {
            if (this.links.get(peer.id)?.channel?.readyState === 'open') {this.relayPeers.delete(peer.id);continue;}
            if (peer.input && result.serverTime-peer.at < 1500) {this.relayPeers.add(peer.id);this.onInput(peer.id,peer.input);}
            else this.onInput(peer.id,{mx:0,my:0,angle:0,fire:false,dash:false,reload:false});
          }
        } else if (result.snapshot && result.seq > this.lastRelaySeq && result.serverTime-result.at < 3000) {
          this.lastRelaySeq=result.seq;this.relayPeers.add(this.hostId);this._relaySnapshot(result.snapshot);
        }
        this._emitPeers();this._diagnose();
      } catch(error) {
        if (generation !== this.generation) return;
        if ([401,410].includes(error.status)) {const message=error.message;this.leave(false);this._status('ended',message);return;}
        if (error.status !== 429) this._diagnosticError('兼容联机',error);
      }
    } else if (this.relayActive) {
      this.relayActive=false;this.relayPeers.clear();this.relaySamples=[];clearInterval(this.interpolationTimer);this.interpolationTimer=null;
      this._status('connected','已切回 WebRTC 低延迟直连。');this._emitPeers();
    }
    if (generation === this.generation && this.roomCode) this.relayTimer=setTimeout(()=>this._relay(generation),250);
  }
  _relaySnapshot(snapshot) {
    this.relaySamples.push({snapshot,at:performance.now()});if(this.relaySamples.length>2)this.relaySamples.shift();
    if(this.relaySamples.length===1)this.onSnapshot(snapshot);
    if(this.interpolationTimer)return;
    this.interpolationTimer=setInterval(()=>{
      if(!this.relayActive || this.isHost || this.links.get(this.hostId)?.channel?.readyState==='open')return;
      const b=this.relaySamples.at(-1),a=this.relaySamples.at(-2);if(!b)return;if(!a){this.onSnapshot(b.snapshot);return;}
      const duration=Math.max(100,Math.min(1000,b.at-a.at)),t=Math.min(1,Math.max(0,(performance.now()-b.at)/duration));
      const players=Object.fromEntries(Object.entries(b.snapshot.players||{}).map(([id,p])=>{const old=a.snapshot.players?.[id];if(!old||old.hp<=0||p.hp<=0||Math.hypot(old.x-p.x,old.y-p.y)>250)return[id,p];return[id,{...p,x:old.x+(p.x-old.x)*t,y:old.y+(p.y-old.y)*t}];}));
      this.onSnapshot({...b.snapshot,players});
    },33);
  }
  async _sendSignal(to, kind, payload) {
    if (!this.roomCode) return;
    try { const result=await this._fetch('/' + this.roomCode + '/signal', {method:'POST',data:{to,kind,payload}}); if (kind !== 'restart') this.diagnosticCounts[kind+'Tx']++; this._diagnose(); return result; } catch(error) {this.diagnosticCounts.signalErrors++;this._diagnosticError('信令发送',error);throw error;}
  }
  _newLink(id, sessionId) {
    this._closeLink(id);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const link = {id, sid:sessionId, pc, channel:null, source:null, gain:null, audio:null, stream:null, pending:[], audioSender:null, micTrack:null,localCandidates:{host:0,srflx:0,relay:0,other:0},remoteCandidates:0};
    this.links.set(id,link);
    const transceiver = pc.addTransceiver('audio',{direction:'sendrecv'}); link.audioSender = transceiver.sender;
    if (this.stream) this._attachMic(link).catch(noop);
    pc.onicecandidate = event => {
      if (event.candidate && this.links.get(id) === link) { const type=event.candidate.type; link.localCandidates[type in link.localCandidates ? type : 'other']++; this._sendSignal(id,'ice',{sid:sessionId,candidate:event.candidate.toJSON()}).catch(noop); } this._diagnose();
    };
    pc.onicecandidateerror = event => { this.diagnosticCounts.iceErrors++;this._diagnosticError('STUN候选 '+event.errorCode,{name:'候选收集错误'}); };
    pc.oniceconnectionstatechange = pc.onicegatheringstatechange = pc.onsignalingstatechange = () => this._diagnose();
    pc.ondatachannel = event => this._bindChannel(link,event.channel);
    pc.ontrack = event => {
      if (event.track.kind !== 'audio') return;
      link.stream = event.streams[0] || new MediaStream([event.track]);
      this._connectAudio(link);
    };
    pc.onconnectionstatechange = () => {
      if (this.links.get(id) !== link) return;
      if (pc.connectionState === 'failed') this._status('connection-error','直连失败，请退出后重新加入房间，或换个网络。部分网络需要 TURN 中继，本原型暂未配置。');
      else if (pc.connectionState === 'disconnected') this._status('reconnecting','一位玩家的连接已中断。');
      this._emitPeers();
    };
    return link;
  }
  async _offer(id) {
    const link = this._newLink(id,sid());
    this._bindChannel(link,link.pc.createDataChannel('arena',{ordered:false,maxRetransmits:0}));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    if (this.links.get(id) !== link) return;
    await this._sendSignal(id,'offer',{sid:link.sid,description:link.pc.localDescription.toJSON()});
  }
  async _signal({sender,kind,payload}) {
    if (!payload || typeof payload !== 'object') return;
    if (kind !== 'restart' && (kind+'Rx') in this.diagnosticCounts) this.diagnosticCounts[kind+'Rx']++;
    if (kind === 'restart') { if (this.selfId < sender) await this._offer(sender); return; }
    if (typeof payload.sid !== 'string' || payload.sid.length > 64) return;
    let link = this.links.get(sender);
    if (kind === 'offer') {
      if (sender > this.selfId || payload.description?.type !== 'offer') return;
      link = this._newLink(sender,payload.sid);
      await link.pc.setRemoteDescription(payload.description);
      await this._drainIce(link);
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      if (this.links.get(sender) === link) await this._sendSignal(sender,'answer',{sid:link.sid,description:link.pc.localDescription.toJSON()});
    } else if (kind === 'answer') {
      if (!link || link.sid !== payload.sid || payload.description?.type !== 'answer' || link.pc.signalingState !== 'have-local-offer') return;
      await link.pc.setRemoteDescription(payload.description); await this._drainIce(link);
    } else if (kind === 'ice' && payload.candidate) {
      if (link?.sid === payload.sid && link.pc.remoteDescription) { link.remoteCandidates++; await link.pc.addIceCandidate(payload.candidate).catch(error=>this._diagnosticError('远端候选',error)); }
      else {
        const key = sender + ':' + payload.sid, queue = this.pendingIce.get(key) || [];
        if (queue.length < 64 && this.pendingIce.size < 30) { queue.push(payload.candidate); this.pendingIce.set(key,queue); }
      }
    }
  }
  async _drainIce(link) {
    const key = link.id + ':' + link.sid, queue = this.pendingIce.get(key) || [];
    this.pendingIce.delete(key);
    for (const candidate of queue) {link.remoteCandidates++;await link.pc.addIceCandidate(candidate).catch(error=>this._diagnosticError('缓存候选',error));}
  }
  _bindChannel(link,channel) {
    link.channel = channel;
    channel.onopen = () => {
      if (this.links.get(link.id) !== link) return;
      this._emitPeers(); this._status('connected',this.isHost ? '玩家已连接。' : link.id === this.hostId ? '已连接房主。' : '语音通道已连接。');
    };
    channel.onclose = () => this._emitPeers();
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 64_000) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'input' && this.isHost) {
        const value = message.value;
        if (!Number.isSafeInteger(message.seq) || message.seq <= (link.lastInputSeq ?? -1)) return;
        link.lastInputSeq = message.seq;
        if (value && ['mx','my','angle'].every(k=>Number.isFinite(value[k]))) this.onInput(link.id,{mx:Math.max(-1,Math.min(1,value.mx)),my:Math.max(-1,Math.min(1,value.my)),angle:value.angle,fire:!!value.fire,dash:!!value.dash,reload:!!value.reload});
      } else if (message.type === 'snapshot' && !this.isHost && link.id === this.hostId) {
        if (!Number.isSafeInteger(message.seq) || message.seq <= this.lastSnapshotSeq) return;
        this.lastSnapshotSeq = message.seq;
        if (message.value && typeof message.value === 'object') this.onSnapshot(message.value);
      } else if (message.type === 'chat' && typeof message.text === 'string' && this._gainFor(link.id) > 0) {
        this.onMessage({from:link.id,text:message.text.slice(0,160)});
      }
    };
  }
  _send(id, message) {
    const channel = this.links.get(id)?.channel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > 128_000) return false;
    const encoded = JSON.stringify(message); if (encoded.length > 60_000) return false;
    try { channel.send(encoded); return true; } catch { return false; }
  }
  sendInput(value) { this.latestInput=value;const seq=++this.inputSeq;if (this.isHost) this.onInput(this.selfId,value); else this._send(this.hostId,{type:'input',value,seq}); }
  broadcastSnapshot(value) { if (!this.isHost) return; this.latestSnapshot=value;const seq = ++this.snapshotSeq; for (const id of this.links.keys()) this._send(id,{type:'snapshot',value,seq}); }
  sendChat(text) {
    text = String(text).trim().slice(0,160); if (!text) return;
    for (const id of this.links.keys()) if (this._gainFor(id) > 0) this._send(id,{type:'chat',text});
    this.onMessage({from:this.selfId,text});
  }
  async retryConnections() {
    for (const peer of this.members) {
      if (peer.id === this.selfId) continue;
      if (this.selfId < peer.id) await this._offer(peer.id);
      else { this._closeLink(peer.id); await this._sendSignal(peer.id,'restart',{}); }
    }
    this._status('connecting','正在重试玩家直连…');
  }
  async resumeAudio() {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    if (!this.audioContext || this.audioContext.state === 'closed') this.audioContext = new Audio();
    await this.audioContext.resume();
    for (const link of this.links.values()) this._connectAudio(link);
  }
  _connectAudio(link) {
    if (!this.audioContext || !link.stream || link.source) return;
    try {
      link.source = this.audioContext.createMediaStreamSource(link.stream);
      link.gain = this.audioContext.createGain(); link.gain.gain.value = 0;
      link.source.connect(link.gain); link.gain.connect(this.audioContext.destination);
      // A muted media element keeps remote WebRTC audio flowing in Chromium. Only WebAudio is audible.
      if (globalThis.document) {
        link.audio = document.createElement('audio'); link.audio.autoplay = true; link.audio.muted = true; link.audio.playsInline = true;
        link.audio.srcObject = link.stream; link.audio.play().catch(noop);
      }
      this._updateGains();
    } catch (error) { this._voice({error:'请点开启麦克风以启用语音播放。'}); }
  }
  /** Call only from a user gesture. Never auto-starts microphone. */
  async enableVoice() {
    if (this.voiceEnabled) { await this.resumeAudio(); return true; }
    if (!this.roomCode) throw new Error('请先创建或加入联机房间，再开启麦克风。');
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('麦克风需要 HTTPS 和支持语音的浏览器。');
    const generation = this.generation;
    try {
      await this.resumeAudio();
      const stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if (generation !== this.generation) { stream.getTracks().forEach(t=>t.stop()); return false; }
      this.stream = stream; const track = stream.getAudioTracks()[0]; track.enabled = false;
      track.onended = () => { this.voiceEnabled = false; this.talking = false; this._voice({error:'麦克风已断开。'}); };
      await Promise.all([...this.links.values()].map(link=>this._attachMic(link)));
      this.voiceEnabled = true; this.talking = false; this._voice(); return true;
    } catch (error) {
      this.disableVoice();
      const message = error.name === 'NotAllowedError' ? '尚未获得麦克风权限，可以继续无语音游玩。' : error.message || '麦克风暂不可用。';
      this._voice({error:message}); throw new Error(message);
    }
  }
  async _attachMic(link) {
    link.micTrack?.stop();
    const source = this.stream?.getAudioTracks()[0];
    if (!source) return;
    link.micTrack = source.clone(); link.micTrack.enabled = false;
    await link.audioSender.replaceTrack(link.micTrack);
    link.micTrack.enabled = this.talking && this._gainFor(link.id) > 0;
  }
  disableVoice() {
    this.talking = false; this.voiceEnabled = false;
    if (this.stream) { this.stream.getTracks().forEach(t=>t.stop()); this.stream = null; }
    for (const link of this.links.values()) { link.micTrack?.stop(); link.micTrack = null; link.audioSender?.replaceTrack(null).catch(noop); }
    this._voice();
  }
  setTalking(value) {
    this.talking = !!value && this.voiceEnabled;
    this._updateGains();
    this._voice();
  }
  setMuted(value) { this.muted = !!value; this._updateGains(); this._voice(); }
  updatePositions(players) {
    const list = Array.isArray(players) ? players : Object.values(players || {});
    this.positions = new Map(list.filter(p=>p && Number.isFinite(p.x) && Number.isFinite(p.y)).map(p=>[p.id,p]));
    this._updateGains();
  }
  _gainFor(id) {
    const me = this.positions.get(this.selfId), other = this.positions.get(id);
    if (!me || !other || me.hp <= 0 || other.hp <= 0) return 0;
    const distance = Math.hypot(me.x-other.x,me.y-other.y);
    return Math.max(0,1-distance/this.voiceRadius) ** 2;
  }
  _updateGains() {
    for (const [id,link] of this.links) {
      if (link.micTrack) link.micTrack.enabled = this.talking && this._gainFor(id) > 0;
      if (!link.gain || !this.audioContext) continue;
      const gain = this.muted ? 0 : this._gainFor(id);
      link.gain.gain.setTargetAtTime(gain,this.audioContext.currentTime,0.08);
    }
  }
  _closeLink(id) {
    const link = this.links.get(id); if (!link) return;
    this.links.delete(id); link.pc.onconnectionstatechange = null;
    try { link.micTrack?.stop(); link.channel?.close(); link.pc.close(); link.source?.disconnect(); link.gain?.disconnect(); if (link.audio) { link.audio.pause(); link.audio.srcObject = null; } } catch {}
  }
  leave(notifyServer = true) {
    if (notifyServer && this.roomCode && this.token) this._fetch('/' + this.roomCode + '/leave',{method:'POST',data:{},keepalive:true}).catch(noop);
    this.generation++; clearTimeout(this.timer); this.timer = null;clearTimeout(this.relayTimer);clearInterval(this.interpolationTimer);this.relayTimer=null;this.interpolationTimer=null;this.relayActive=false;this.relayPeers.clear();this.latestInput=null;this.latestSnapshot=null;this.relaySamples=[];this.lastRelaySeq=0;
    this.disableVoice();
    for (const id of [...this.links.keys()]) this._closeLink(id);
    this.pendingIce.clear(); this.positions.clear(); this.members=[];
    this.roomCode=''; this.selfId=''; this.hostId=''; this.token=''; this.isHost=false; this.cursor=0; this.inputSeq=0; this.snapshotSeq=0; this.lastSnapshotSeq=-1;
    this.onPeers([]); this._diagnose();
  }
  destroy() {
    this.leave(); globalThis.removeEventListener?.('blur',this._release); globalThis.document?.removeEventListener('visibilitychange',this._release);
    this.audioContext?.close().catch(noop); this.audioContext=null;
  }
}
