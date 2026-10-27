/** Lightweight synthesized arena audio. Never requests microphone access.
 * Call unlock() inside the user's click handler. Feed fresh engine events to play().
 * toggle() returns the new enabled state; enabled starts true but nothing plays before unlock.
 */
export function createSFX(){
  let ctx=null,master=null,noise=null,enabled=true,lastId=0,lastShotAt=-1,lastImpactAt=-1;
  function init(){
    if(ctx)return;
    const AudioContext=globalThis.AudioContext||globalThis.webkitAudioContext;
    if(!AudioContext)return;
    ctx=new AudioContext();master=ctx.createGain();master.gain.value=.17;master.connect(ctx.destination);
    noise=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*.5),ctx.sampleRate);
    const data=noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;
  }
  async function unlock(){try{init();if(ctx?.state==='suspended')await ctx.resume();return ctx?.state==='running';}catch{return false;}}
  function burst({duration=.08,volume=.3,frequency=1800,filter='lowpass',delay=0}){
    const now=ctx.currentTime+delay,source=ctx.createBufferSource(),tone=ctx.createBiquadFilter(),env=ctx.createGain();
    source.buffer=noise;tone.type=filter;tone.frequency.setValueAtTime(frequency,now);tone.Q.value=.6;
    env.gain.setValueAtTime(.001,now);env.gain.linearRampToValueAtTime(volume,now+.003);env.gain.exponentialRampToValueAtTime(.001,now+duration);
    source.connect(tone);tone.connect(env);env.connect(master);source.start(now);source.stop(now+duration+.01);source.onended=()=>{source.disconnect();tone.disconnect();env.disconnect();};
  }
  function pitch({start=130,end=45,duration=.08,volume=.2,type='triangle',delay=0}){
    const now=ctx.currentTime+delay,osc=ctx.createOscillator(),env=ctx.createGain();osc.type=type;osc.frequency.setValueAtTime(start,now);osc.frequency.exponentialRampToValueAtTime(Math.max(15,end),now+duration);
    env.gain.setValueAtTime(volume,now);env.gain.exponentialRampToValueAtTime(.001,now+duration);osc.connect(env);env.connect(master);osc.start(now);osc.stop(now+duration+.01);osc.onended=()=>{osc.disconnect();env.disconnect();};
  }
  function play(event,selfId){
    if(!event||!enabled||!ctx||ctx.state!=='running')return;
    // Event IDs reset with each newly-created world. Parent should feed only new events.
    // Suppress exact duplicate events while allowing lower IDs after a world reset.
    if(event.id&&event.id===lastId)return;lastId=event.id||0;
    const now=ctx.currentTime;
    switch(event.type){
      case 'shot':
        if(now-lastShotAt<.035)return;lastShotAt=now;
        burst({duration:.055,volume:.32,frequency:2600,filter:'highpass'});pitch({start:125,end:42,duration:.065,volume:.34});break;
      case 'hit':
        if(now-lastImpactAt<.035)return;lastImpactAt=now;
        burst({duration:.045,volume:.16,frequency:1500});pitch({start:730,end:310,duration:.035,volume:.045});break;
      case 'break':
        burst({duration:.17,volume:.31,frequency:1700});burst({duration:.09,volume:.12,frequency:3100,delay:.055});pitch({start:92,end:30,duration:.13,volume:.21});break;
      case 'damage':
        if(event.target===selfId){burst({duration:.09,volume:.21,frequency:900});pitch({start:145,end:58,duration:.12,volume:.2});}
        else if(event.owner===selfId){pitch({start:960,end:720,duration:.045,volume:.13});}
        break;
      case 'kill':
        if(event.owner===selfId){pitch({start:570,end:760,duration:.08,volume:.14});pitch({start:880,end:1100,duration:.1,volume:.11,delay:.055});}
        else if(event.target===selfId){pitch({start:170,end:35,duration:.24,volume:.22});}break;
      case 'dash':burst({duration:.105,volume:.11,frequency:2800,filter:'bandpass'});break;
      case 'round':pitch({start:440,end:440,duration:.11,volume:.13});pitch({start:660,end:660,duration:.14,volume:.12,delay:.13});break;
    }
  }
  function toggle(){enabled=!enabled;if(master&&ctx)master.gain.setTargetAtTime(enabled?.17:0,ctx.currentTime,.015);return enabled;}
  return{unlock,play,toggle,get enabled(){return enabled;}};
}
