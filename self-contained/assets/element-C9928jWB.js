import{m as be,h as Z,n as z,i as Vt,_ as Wt,b as $t,j as ve,k as Se,o as M,l as st,p as g,q as Ae,u as ot,r as qt,s as Ht,t as T,v as Xt,w as wt,x as Yt,y as xe,S as f,E as x,M as u,f as ct,z as Gt,c as ke,A as gt,R as Ue,g as xt}from"./time-DsB_1cAJ.js";import{_ as kt}from"./index-DqahU7yv.js";let Te=class{#t;#e;#i;#n;#s=0;constructor(e,n={}){this.#t=e,this.#e=n.schema}async next(){for(;;){if(!this.#i){if(this.#i=await this.#t.nextGroupOrdered(),!this.#i)return;this.#n=void 0,this.#s=0}const e=await this.#i.readFrame();if(e===void 0){this.#i=void 0;continue}return this.#r(e)}}async*[Symbol.asyncIterator](){for(;;){const e=await this.next();if(e===void 0)return;yield e}}#r(e){const n=JSON.parse(new TextDecoder().decode(e));return this.#s===0?this.#n=n:this.#n=be(this.#n,n),this.#s+=1,this.#e?this.#e.parse(this.#n):this.#n}};const Me=6,Ee=8,Ut=1e6;let lt=class{decode(e){const[n,i]=Z(e);if(i.byteLength<n)throw new Error("loc: properties_length exceeds frame size");const s=i.subarray(0,n),r=i.subarray(n);let a,c,o=0,l=!0,d=s;for(;d.byteLength>0;){const[p,y]=Z(d),w=l?p:o+p;if(l=!1,o=w,d=y,w%2===0){const[b,v]=Z(d);if(d=v,w===Me)a=b;else if(w===Ee){if(b===0)throw new Error("loc: timescale property must be non-zero");c=b}}else{const[b,v]=Z(d);if(v.byteLength<b)throw new Error("loc: property length exceeds remaining bytes");d=v.subarray(b)}}if(a===void 0)throw new Error("loc: frame missing required timestamp property");const h=c??Ut,m=Math.round(a*Ut/h);return[{data:r,timestamp:m,keyframe:!1}]}};function Kt(t){return t instanceof ArrayBuffer||typeof SharedArrayBuffer<"u"&&t instanceof SharedArrayBuffer}const ze="utf-16",ut="utf-16be",Tt="utf-16le",tt="utf-8";function Jt(t,e={}){let n;Kt(t)?n=new DataView(t):n=new DataView(t.buffer,t.byteOffset,t.byteLength);let i=0,{encoding:s}=e;if(!s){const l=n.getUint8(0),d=n.getUint8(1);l==239&&d==187&&n.getUint8(2)==191?(s=tt,i=3):l==254&&d==255?(s=ut,i=2):l==255&&d==254?(s=Tt,i=2):s=tt}if(typeof TextDecoder<"u")return new TextDecoder(s).decode(n);const{byteLength:r}=n,a=s!==ut;let c="",o;for(;i<r;){switch(s){case tt:if(o=n.getUint8(i),o<128)i++;else if(o>=194&&o<=223)if(i+1<r){const l=n.getUint8(i+1);l>=128&&l<=191?(o=(o&31)<<6|l&63,i+=2):i++}else i++;else if(o>=224&&o<=239)if(i+2<=r-1){const l=n.getUint8(i+1),d=n.getUint8(i+2);l>=128&&l<=191&&d>=128&&d<=191?(o=(o&15)<<12|(l&63)<<6|d&63,i+=3):i++}else i++;else if(o>=240&&o<=244)if(i+3<=r-1){const l=n.getUint8(i+1),d=n.getUint8(i+2),h=n.getUint8(i+3);l>=128&&l<=191&&d>=128&&d<=191&&h>=128&&h<=191?(o=(o&7)<<18|(l&63)<<12|(d&63)<<6|h&63,i+=4):i++}else i++;else i++;break;case ut:case ze:case Tt:o=n.getUint16(i,a),i+=2;break}c+=String.fromCodePoint(o)}return c}function Be(t){return new TextEncoder().encode(t)}function Ce(t){return{writers:t?.writers??{}}}const Ie=["dinf","edts","grpl","mdia","meco","mfra","minf","moof","moov","mvex","schi","sinf","stbl","strk","traf","trak","tref","udta","vttc"];function Qt(t){return"boxes"in t||Ie.includes(t.type)}const Mt="utf8",E="uint",H="template",Et="string",zt="int",Bt="data";var k=class{constructor(t,e){this.writeUint=(n,i)=>{const{dataView:s,cursor:r}=this;switch(i){case 1:s.setUint8(r,n);break;case 2:s.setUint16(r,n);break;case 3:{const a=(n&16776960)>>8,c=n&255;s.setUint16(r,a),s.setUint8(r+2,c);break}case 4:s.setUint32(r,n);break;case 8:{const a=Math.floor(n/Math.pow(2,32)),c=n-a*Math.pow(2,32);s.setUint32(r,a),s.setUint32(r+4,c);break}}this.cursor+=i},this.writeInt=(n,i)=>{const{dataView:s,cursor:r}=this;switch(i){case 1:s.setInt8(r,n);break;case 2:s.setInt16(r,n);break;case 4:s.setInt32(r,n);break;case 8:const a=Math.floor(n/Math.pow(2,32)),c=n-a*Math.pow(2,32);s.setUint32(r,a),s.setUint32(r+4,c);break}this.cursor+=i},this.writeString=n=>{for(let i=0,s=n.length;i<s;i++)this.writeUint(n.charCodeAt(i),1)},this.writeTerminatedString=n=>{if(n.length!==0){for(let i=0,s=n.length;i<s;i++)this.writeUint(n.charCodeAt(i),1);this.writeUint(0,1)}},this.writeUtf8TerminatedString=n=>{const i=Be(n);new Uint8Array(this.dataView.buffer).set(i,this.cursor),this.cursor+=i.length,this.writeUint(0,1)},this.writeBytes=n=>{Array.isArray(n)||(n=[n]);for(const i of n)new Uint8Array(this.dataView.buffer).set(i,this.cursor),this.cursor+=i.length},this.writeArray=(n,i,s,r)=>{const a=i===E?this.writeUint:i===H?this.writeTemplate:this.writeInt;for(let c=0;c<r;c++)a(n[c]??0,s)},this.writeTemplate=(n,i)=>{const r=Math.round(n*Math.pow(2,i===4?16:8));this.writeUint(r,i)},this.writeBoxHeader=(n,i)=>{i>4294967295?(this.writeUint(1,4),this.writeString(n),this.writeUint(i,8)):(this.writeUint(i,4),this.writeString(n))},this.dataView=new DataView(new ArrayBuffer(e)),this.cursor=0,this.writeBoxHeader(t,e)}get buffer(){return this.dataView.buffer}get byteLength(){return this.dataView.byteLength}get byteOffset(){return this.dataView.byteOffset}writeFullBox(t,e){this.writeUint(t,1),this.writeUint(e,3)}};function Zt(t,e){return Array.from(t,n=>Le(n,e))}function yt(t,e){const n=Zt(t,e);return{bytes:n,size:n.reduce((i,s)=>i+s.byteLength,0)}}function De(t,e){const{bytes:i,size:s}=yt(t.boxes,e),r=8+s,a=new k(t.type,r);return a.writeBytes(i),a}function Le(t,e){let n=null;if("type"in t){const{type:i}=t,s=e.writers?.[i];if(s?n=s(t,e):Qt(t)?n=De(t,e):"view"in t&&(n=t.view),!n)throw new Error(`No writer found for box type: ${i}`)}if("buffer"in t&&(n=t),!n)throw new Error("Invalid box");return new Uint8Array(n.buffer,n.byteOffset,n.byteLength)}function Re(t,e,n){const i=n>0?n:t.byteLength-(e-t.byteOffset);return new Uint8Array(t.buffer,e,Math.max(i,0))}function _e(t,e,n){let i=NaN;const s=e-t.byteOffset;switch(n){case 1:i=t.getInt8(s);break;case 2:i=t.getInt16(s);break;case 4:i=t.getInt32(s);break;case 8:const r=t.getInt32(s),a=t.getInt32(s+4);i=r*Math.pow(2,32)+a;break}return i}function W(t,e,n){const i=e-t.byteOffset;let s=NaN,r,a;switch(n){case 1:s=t.getUint8(i);break;case 2:s=t.getUint16(i);break;case 3:r=t.getUint16(i),a=t.getUint8(i+2),s=(r<<8)+a;break;case 4:s=t.getUint32(i);break;case 8:r=t.getUint32(i),a=t.getUint32(i+4),s=r*Math.pow(2,32)+a;break}return s}function Ct(t,e,n){let i="";for(let s=0;s<n;s++){const r=W(t,e+s,1);i+=String.fromCharCode(r)}return i}function Fe(t,e,n){const i=n/2;return W(t,e,i)+W(t,e+i,i)/Math.pow(2,i)}function Oe(t,e){let n="",i=e;for(;i-t.byteOffset<t.byteLength;){const s=W(t,i,1);if(s===0)break;n+=String.fromCharCode(s),i++}return n}function Ne(t,e){const n=t.byteLength-(e-t.byteOffset);return n>0?Jt(new DataView(t.buffer,e,n),{encoding:tt}):""}function je(t,e){const n=t.byteLength-(e-t.byteOffset);let i="";if(n>0){const s=new DataView(t.buffer,e,n);let r=0;for(;r<n&&s.getUint8(r)!==0;r++);i=Jt(new DataView(t.buffer,e,r),{encoding:tt})}return i}var Pe=class te{constructor(e,n){this.truncated=!1,this.slice=(i,s)=>{const r=new te(new DataView(this.dataView.buffer,i,s),this.config),a=this.offset-i,c=s-a;return this.offset+=c,r.jump(a),r},this.read=(i,s=0)=>{const{dataView:r,offset:a}=this;let c,o=s;switch(i){case E:c=W(r,a,s);break;case zt:c=_e(r,a,s);break;case H:c=Fe(r,a,s);break;case Et:s===-1?(c=Oe(r,a),o=c.length+1):c=Ct(r,a,s);break;case Bt:c=Re(r,a,s),o=c.length;break;case Mt:s===-1?(c=je(r,a),o=c.length+1):c=Ne(r,a);break;default:c=-1}return this.offset+=o,c},this.readUint=i=>this.read(E,i),this.readInt=i=>this.read(zt,i),this.readString=i=>this.read(Et,i),this.readTemplate=i=>this.read(H,i),this.readData=i=>this.read(Bt,i),this.readUtf8=i=>this.read(Mt,i),this.readFullBox=()=>({version:this.readUint(1),flags:this.readUint(3)}),this.readArray=(i,s,r)=>{const a=[];for(let c=0;c<r;c++)a.push(this.read(i,s));return a},this.jump=i=>{this.offset+=i},this.readBox=()=>{const{dataView:i,offset:s}=this;let r=0;const a=W(i,s,4),c=Ct(i,s+4,4),o={size:a,type:c};r+=8,o.size===1&&(o.largesize=W(i,s+r,8),r+=8);const l=o.size===0?this.bytesRemaining:o.largesize??o.size;if(this.cursor+l>i.byteLength)throw this.truncated=!0,new Error("Truncated box");return this.jump(r),c==="uuid"&&(o.usertype=this.readArray("uint",1,16)),o.view=this.slice(s,l),o},this.readBoxes=(i=-1)=>{const s=[];for(const r of this)if(s.push(r),i>0&&s.length>=i)break;return s},this.readEntries=(i,s)=>{const r=[];for(let a=0;a<i;a++)r.push(s());return r},this.dataView=Kt(e)?new DataView(e):e instanceof DataView?e:new DataView(e.buffer,e.byteOffset,e.byteLength),this.offset=this.dataView.byteOffset,this.config=n||{}}get buffer(){return this.dataView.buffer}get byteOffset(){return this.dataView.byteOffset}get byteLength(){return this.dataView.byteLength}get cursor(){return this.offset-this.dataView.byteOffset}get done(){return this.cursor>=this.dataView.byteLength||this.truncated}get bytesRemaining(){return this.dataView.byteLength-this.cursor}*[Symbol.iterator](){const{readers:e={}}=this.config;for(;!this.done;)try{const n=this.readBox(),{type:i,view:s}=n,r=e[i]||e[i.trim()];if(r&&Object.assign(n,r(s,i)),Qt(n)&&!n.boxes){const a=[];for(const c of s)a.push(c);n.boxes=a}yield n}catch(n){if(n instanceof Error&&n.message==="Truncated box")break;throw n}}};function bt(t,e){const n=[];for(const i of new Pe(t,e))n.push(i);return n}function Ve(t,e){return Zt(t,Ce(e))}function We(t,e){const{readArray:n,readUint:i,readTemplate:s,readBoxes:r}=e;return{type:t,reserved1:n(E,1,6),dataReferenceIndex:i(2),reserved2:n(E,4,2),channelcount:i(2),samplesize:i(2),preDefined:i(2),reserved3:i(2),samplerate:s(4),boxes:r()}}function vt(t,e){const{readArray:n,readUint:i,readInt:s,readTemplate:r,readBoxes:a}=e;return{type:t,reserved1:n(E,1,6),dataReferenceIndex:i(2),preDefined1:i(2),reserved2:i(2),preDefined2:n(E,4,3),width:i(2),height:i(2),horizresolution:r(4),vertresolution:r(4),reserved3:i(4),frameCount:i(2),compressorName:n(E,1,32),depth:i(2),preDefined3:s(2),boxes:a()}}function It(t){return vt("avc1",t)}function $e(t){return vt("hev1",t)}function qe(t){return vt("hvc1",t)}function He(t){return{type:"mdat",data:t.readData(-1)}}function Xe(t){const{version:e,flags:n}=t.readFullBox(),i=t.readUint(e==1?8:4),s=t.readUint(e==1?8:4),r=t.readUint(4),a=t.readUint(e==1?8:4),c=t.readUint(2);return{type:"mdhd",version:e,flags:n,creationTime:i,modificationTime:s,timescale:r,duration:a,language:String.fromCharCode((c>>10&31)+96,(c>>5&31)+96,(c&31)+96),preDefined:t.readUint(2)}}function Ye(t){return{type:"mfhd",...t.readFullBox(),sequenceNumber:t.readUint(4)}}function Ge(t){return We("mp4a",t)}function Ke(t){const{version:e,flags:n}=t.readFullBox(),i=t.readUint(4);return{type:"stsd",version:e,flags:n,entryCount:i,entries:t.readBoxes(i)}}function Je(t){const{version:e,flags:n}=t.readFullBox();return{type:"tfdt",version:e,flags:n,baseMediaDecodeTime:t.readUint(e==1?8:4)}}function Qe(t){const{version:e,flags:n}=t.readFullBox();return{type:"tfhd",version:e,flags:n,trackId:t.readUint(4),baseDataOffset:n&1?t.readUint(8):void 0,sampleDescriptionIndex:n&2?t.readUint(4):void 0,defaultSampleDuration:n&8?t.readUint(4):void 0,defaultSampleSize:n&16?t.readUint(4):void 0,defaultSampleFlags:n&32?t.readUint(4):void 0}}function Ze(t){const{version:e,flags:n}=t.readFullBox(),i=e===1?8:4;return{type:"tkhd",version:e,flags:n,creationTime:t.readUint(i),modificationTime:t.readUint(i),trackId:t.readUint(4),reserved1:t.readUint(4),duration:t.readUint(i),reserved2:t.readArray(E,4,2),layer:t.readUint(2),alternateGroup:t.readUint(2),volume:t.readTemplate(2),reserved3:t.readUint(2),matrix:t.readArray(H,4,9),width:t.readTemplate(4),height:t.readTemplate(4)}}function tn(t){return{type:"trex",...t.readFullBox(),trackId:t.readUint(4),defaultSampleDescriptionIndex:t.readUint(4),defaultSampleDuration:t.readUint(4),defaultSampleSize:t.readUint(4),defaultSampleFlags:t.readUint(4)}}function en(t){const{version:e,flags:n}=t.readFullBox(),i=t.readUint(4);let s,r;n&1&&(s=t.readInt(4)),n&4&&(r=t.readUint(4));const a=t.readEntries(i,()=>{const c={};return n&256&&(c.sampleDuration=t.readUint(4)),n&512&&(c.sampleSize=t.readUint(4)),n&1024&&(c.sampleFlags=t.readUint(4)),n&2048&&(c.sampleCompositionTimeOffset=e===1?t.readInt(4):t.readUint(4)),c});return{type:"trun",version:e,flags:n,sampleCount:i,dataOffset:s,firstSampleFlags:r,samples:a}}function nn(t,e){const r=t.entries.length,{bytes:a,size:c}=yt(t.entries,e),o=new k("dref",16+c);return o.writeFullBox(t.version,t.flags),o.writeUint(r,4),o.writeBytes(a),o}function sn(t){const s=t.compatibleBrands.length*4,r=new k("ftyp",16+s);r.writeString(t.majorBrand),r.writeUint(t.minorVersion,4);for(const a of t.compatibleBrands)r.writeString(a);return r}function rn(t){const a=t.name.length+1,c=new k("hdlr",32+a);return c.writeFullBox(t.version,t.flags),c.writeUint(t.preDefined,4),c.writeString(t.handlerType),c.writeArray(t.reserved,E,4,3),c.writeTerminatedString(t.name),c}function an(t){const e=new k("mdat",8+t.data.length);return e.writeBytes(t.data),e}function on(t){const e=t.version===1?8:4,n=8,i=4,s=e*3,r=new k("mdhd",n+i+s+4+2+2);r.writeFullBox(t.version,t.flags),r.writeUint(t.creationTime,e),r.writeUint(t.modificationTime,e),r.writeUint(t.timescale,4),r.writeUint(t.duration,e);const a=t.language.length>=3?(t.language.charCodeAt(0)-96&31)<<10|(t.language.charCodeAt(1)-96&31)<<5|t.language.charCodeAt(2)-96&31:0;return r.writeUint(a,2),r.writeUint(t.preDefined,2),r}function cn(t){const e=new k("mfhd",16);return e.writeFullBox(t.version,t.flags),e.writeUint(t.sequenceNumber,4),e}function ln(t){const e=t.version===1?8:4,n=8,i=4,s=e*3,r=new k("mvhd",n+i+s+4+4+2+2+8+36+24+4);return r.writeFullBox(t.version,t.flags),r.writeUint(t.creationTime,e),r.writeUint(t.modificationTime,e),r.writeUint(t.timescale,4),r.writeUint(t.duration,e),r.writeTemplate(t.rate,4),r.writeTemplate(t.volume,2),r.writeUint(t.reserved1,2),r.writeArray(t.reserved2,E,4,2),r.writeArray(t.matrix,H,4,9),r.writeArray(t.preDefined,E,4,6),r.writeUint(t.nextTrackId,4),r}function dn(t){const e=new k("smhd",16);return e.writeFullBox(t.version,t.flags),e.writeUint(t.balance,2),e.writeUint(t.reserved,2),e}function fn(t,e){const r=t.entries.length,{bytes:a,size:c}=yt(t.entries,e),o=new k("stsd",16+c);return o.writeFullBox(t.version,t.flags),o.writeUint(r,4),o.writeBytes(a),o}function un(t){const s=t.entryCount*8,r=new k("stts",16+s);r.writeFullBox(t.version,t.flags),r.writeUint(t.entryCount,4);for(const a of t.entries)r.writeUint(a.sampleCount,4),r.writeUint(a.sampleDelta,4);return r}function hn(t){const e=t.version===1?8:4,n=8,i=4,s=e,r=new k("tfdt",n+i+s);return r.writeFullBox(t.version,t.flags),r.writeUint(t.baseMediaDecodeTime,e),r}function mn(t){const s=t.flags&1?8:0,r=t.flags&2?4:0,a=t.flags&8?4:0,c=t.flags&16?4:0,o=t.flags&32?4:0,l=new k("tfhd",16+s+r+a+c+o);return l.writeFullBox(t.version,t.flags),l.writeUint(t.trackId,4),t.flags&1&&l.writeUint(t.baseDataOffset??0,8),t.flags&2&&l.writeUint(t.sampleDescriptionIndex??0,4),t.flags&8&&l.writeUint(t.defaultSampleDuration??0,4),t.flags&16&&l.writeUint(t.defaultSampleSize??0,4),t.flags&32&&l.writeUint(t.defaultSampleFlags??0,4),l}function pn(t){const e=t.version===1?8:4,n=8,i=4,s=e*3,r=new k("tkhd",n+i+s+4+4+8+2+2+2+2+36+4+4);return r.writeFullBox(t.version,t.flags),r.writeUint(t.creationTime,e),r.writeUint(t.modificationTime,e),r.writeUint(t.trackId,4),r.writeUint(t.reserved1,4),r.writeUint(t.duration,e),r.writeArray(t.reserved2,E,4,2),r.writeUint(t.layer,2),r.writeUint(t.alternateGroup,2),r.writeTemplate(t.volume,2),r.writeUint(t.reserved3,2),r.writeArray(t.matrix,H,4,9),r.writeTemplate(t.width,4),r.writeTemplate(t.height,4),r}function gn(t){const e=new k("trex",32);return e.writeFullBox(t.version,t.flags),e.writeUint(t.trackId,4),e.writeUint(t.defaultSampleDescriptionIndex,4),e.writeUint(t.defaultSampleDuration,4),e.writeUint(t.defaultSampleSize,4),e.writeUint(t.defaultSampleFlags,4),e}function wn(t){const s=t.flags&1?4:0,r=t.flags&4?4:0;let a=0;t.flags&256&&(a+=4),t.flags&512&&(a+=4),t.flags&1024&&(a+=4),t.flags&2048&&(a+=4);const c=a*t.sampleCount,o=new k("trun",16+s+r+c);o.writeFullBox(t.version,t.flags),o.writeUint(t.sampleCount,4),t.flags&1&&o.writeUint(t.dataOffset??0,4),t.flags&4&&o.writeUint(t.firstSampleFlags??0,4);for(const l of t.samples)t.flags&256&&o.writeUint(l.sampleDuration??0,4),t.flags&512&&o.writeUint(l.sampleSize??0,4),t.flags&1024&&o.writeUint(l.sampleFlags??0,4),t.flags&2048&&o.writeUint(l.sampleCompositionTimeOffset??0,4);return o}function yn(t){const i=t.location.length+1,s=new k("url ",12+i);return s.writeFullBox(t.version,t.flags),s.writeTerminatedString(t.location),s}function bn(t){const e=new k("vmhd",20);return e.writeFullBox(t.version,t.flags),e.writeUint(t.graphicsmode,2),e.writeArray(t.opcolor,E,2,3),e}z().check(Vt(),Wt(),$t(255)).brand("u8");const U=z().check(Vt(),Wt(),$t(Number.MAX_SAFE_INTEGER)).brand("u53");function O(t){return U.parse(t)}const ee=ve(Se("kind",[M({kind:st("legacy")}),M({kind:st("cmaf"),init:Ae(),timescale:g(U),trackId:g(U)}),M({kind:st("loc")})]),{kind:"legacy"}),vn=M({name:T()}),Dt=M({codec:T(),container:ee,description:g(T()),sampleRate:U,numberOfChannels:U,bitrate:g(U),jitter:g(U)}),Sn=ot([M({renditions:Ht(T(),Dt)}),qt(M({track:vn,config:Dt}),Xt(t=>({renditions:{[t.track.name]:t.config}})))]),An=M({name:T()}),Lt=M({codec:T(),container:ee,description:g(T()),codedWidth:g(U),codedHeight:g(U),displayAspectWidth:g(U),displayAspectHeight:g(U),framerate:g(z()),bitrate:g(U),optimizeForLatency:g(wt()),jitter:g(U)}),xn=ot([M({renditions:Ht(T(),Lt),display:g(M({width:U,height:U})),rotation:g(z()),flip:g(wt())}),qt(Yt(M({track:An,config:Lt})),Xt(t=>{const e=t[0]?.config;return{renditions:Object.fromEntries(t.map(n=>[n.track.name,n.config])),display:e?.displayAspectWidth!==void 0&&e?.displayAspectHeight!==void 0?{width:e.displayAspectWidth,height:e.displayAspectHeight}:void 0,rotation:void 0,flip:void 0}}))]),kn=xe({video:g(xn),audio:g(Sn)}),ne=["hang","msf"],Un="hang";function Tn(t){for(const e of ne)if(t.endsWith(`.${e}`))return e}const X={catalog:100,audio:80,video:60},Mn={avc1:It,avc3:It,hvc1:qe,hev1:$e,mp4a:Ge,stsd:Ke,mdhd:Xe,tkhd:Ze,trex:tn},ie={mfhd:Ye,tfhd:Qe,tfdt:Je,trun:en,mdat:He};function C(t,e){for(const n of t){if(e(n))return n;const i=n.boxes;if(i&&Array.isArray(i)){const s=C(i,e);if(s)return s}}}function St(t){const e=new ArrayBuffer(t.byteLength);return new Uint8Array(e).set(t),e}function N(t){return e=>e.type===t}function G(t){const e=bt(St(t),{readers:Mn}),n=C(e,N("mdhd"));if(!n)throw new Error("No mdhd box found in init segment");const s=C(e,N("tkhd"))?.trackId??1,r=C(e,N("stsd"));if(!r?.entries||r.entries.length===0)throw new Error("No stsd box found in init segment");const a=r.entries[0],c=En(a),o=C(e,l=>l.type==="trex"&&l.trackId===s);return{description:c,timescale:n.timescale,trackId:s,defaultSampleDuration:o?.defaultSampleDuration??0,defaultSampleSize:o?.defaultSampleSize??0,defaultSampleFlags:o?.defaultSampleFlags??0}}function En(t){if(!(!t.boxes||!Array.isArray(t.boxes)))for(const e of t.boxes){if(e instanceof Uint8Array){if(e.length>8){const i=String.fromCharCode(e[4],e[5],e[6],e[7]);if(i==="avcC"||i==="hvcC"||i==="dOps")return new Uint8Array(e.slice(8));if(i==="esds")return Rt(new Uint8Array(e.slice(8)))}continue}const n=e.type;if(n==="avcC"||n==="hvcC"||n==="dOps"){if(e.view){const i=e.view,s=8,r=i.byteOffset+s,a=e.size-s;return new Uint8Array(i.buffer,r,a)}if(e.data instanceof Uint8Array)return new Uint8Array(e.data);if(e.raw instanceof Uint8Array)return new Uint8Array(e.raw.slice(8))}if(n==="esds"){let i;if(e.view){const s=e.view,r=8;i=new Uint8Array(s.buffer,s.byteOffset+r,e.size-r)}else e.data instanceof Uint8Array?i=new Uint8Array(e.data):e.raw instanceof Uint8Array&&(i=new Uint8Array(e.raw.slice(8)));if(i)return Rt(i)}}}function Rt(t){let e=4;for(;e<t.length;){const n=t[e++];let i=0;for(let s=0;s<4&&e<t.length;s++){const r=t[e++];if(i=i<<7|r&127,(r&128)===0)break}if(n===5)return e+i<=t.length?new Uint8Array(t.buffer,t.byteOffset+e,i):void 0;n===3?e+=3:n===4?e+=13:e+=i}}function se(t,e){const n=bt(St(t),{readers:ie});return(C(n,N("tfdt"))?.baseMediaDecodeTime??0)*1e6/e.timescale}function zn(t,e){const n=bt(St(t),{readers:ie}),s=C(n,N("tfdt"))?.baseMediaDecodeTime??0,r=C(n,N("tfhd")),a=r?.defaultSampleDuration??e.defaultSampleDuration,c=r?.defaultSampleSize??e.defaultSampleSize,o=r?.defaultSampleFlags??e.defaultSampleFlags,l=C(n,N("trun"));if(!l)throw new Error("No trun box found in data segment");const d=C(n,N("mdat"));if(!d)throw new Error("No mdat box found in data segment");const h=d.data;if(!h)throw new Error("No data in mdat box");const m=[];let p=0,y=s;for(let w=0;w<l.sampleCount;w++){const b=l.samples[w]??{},v=b.sampleSize??c,S=b.sampleDuration??a;if(v<=0)throw new Error(`Invalid sample size ${v} for sample ${w} in trun`);if(S<0)throw new Error(`Invalid sample duration ${S} for sample ${w} in trun`);if(p+v>h.length)throw new Error(`Sample ${w} would overflow mdat: offset=${p}, size=${v}, mdatLength=${h.length}`);const j=w===0&&l.firstSampleFlags!==void 0?l.firstSampleFlags:b.sampleFlags??o,L=b.sampleCompositionTimeOffset??0,P=new Uint8Array(h.slice(p,p+v));p+=v;const V=y+L,R=Math.round(V*1e6/e.timescale),A=j===0||(j&65536)===0;m.push({data:P,timestamp:R,keyframe:A}),y+=S}return m}const Bn={96e3:0,88200:1,64e3:2,48e3:3,44100:4,32e3:5,24e3:6,22050:7,16e3:8,12e3:9,11025:10,8e3:11,7350:12},_t=2;function Cn(t){return t>=1&&t<=6?t:t===8?7:2}function In(t,e){const n=Cn(e),i=Bn[t];if(i!==void 0){const a=_t<<3|i>>1,c=(i&1)<<7|n<<3;return new Uint8Array([a,c])}let s=0n;s|=BigInt(_t)<<35n,s|=0xfn<<31n,s|=BigInt(t)<<7n,s|=BigInt(n)<<3n;const r=new Uint8Array(5);for(let a=0;a<r.length;a++)r[a]=Number(s>>BigInt((r.length-1-a)*8)&0xffn);return r}function D(t){if(t=t.startsWith("0x")?t.slice(2):t,t.length%2)throw new Error("invalid hex string length");const e=t.match(/.{2}/g);if(!e)throw new Error("invalid hex string format");return new Uint8Array(e.map(n=>parseInt(n,16)))}const rt=[65536,0,0,0,65536,0,0,0,1073741824],Dn={ftyp:sn,mvhd:ln,tkhd:pn,mdhd:on,hdlr:rn,vmhd:bn,smhd:dn,"url ":yn,dref:nn,stsd:fn,stts:un,trex:gn,mfhd:cn,tfhd:mn,tfdt:hn,trun:wn,mdat:an};function et(t){return Ve(t,{writers:Dn})}function At(t,e,n,i){const s=12+i.length,r=new Uint8Array(s),a=new DataView(r.buffer);return a.setUint32(0,s,!1),r[4]=t.charCodeAt(0),r[5]=t.charCodeAt(1),r[6]=t.charCodeAt(2),r[7]=t.charCodeAt(3),a.setUint32(8,e<<24|n,!1),r.set(i,12),r}function re(){const t=new Uint8Array(4);return At("stsc",0,0,t)}function ae(){const t=new Uint8Array(8);return At("stsz",0,0,t)}function oe(){const t=new Uint8Array(4);return At("stco",0,0,t)}function Ln(t,e,n){const i=8+n.length,r=8+(78+i),a=new Uint8Array(r),c=new DataView(a.buffer);let o=0;return c.setUint32(o,r,!1),o+=4,a[o++]=97,a[o++]=118,a[o++]=99,a[o++]=49,o+=6,c.setUint16(o,1,!1),o+=2,c.setUint16(o,0,!1),o+=2,c.setUint16(o,0,!1),o+=2,o+=12,c.setUint16(o,t,!1),o+=2,c.setUint16(o,e,!1),o+=2,c.setUint32(o,4718592,!1),o+=4,c.setUint32(o,4718592,!1),o+=4,c.setUint32(o,0,!1),o+=4,c.setUint16(o,1,!1),o+=2,o+=32,c.setUint16(o,24,!1),o+=2,c.setUint16(o,65535,!1),o+=2,c.setUint32(o,i,!1),o+=4,a[o++]=97,a[o++]=118,a[o++]=99,a[o++]=67,a.set(n,o),a}function Rn(t){const{codedWidth:e,codedHeight:n,description:i}=t;if(!e||!n||!i)throw new Error("Missing required fields to create video init segment");const s=1e6,r=1,a={type:"ftyp",majorBrand:"isom",minorVersion:512,compatibleBrands:["isom","iso6","mp41"]},c={type:"mvhd",version:0,flags:0,creationTime:0,modificationTime:0,timescale:s,duration:0,rate:65536,volume:256,reserved1:0,reserved2:[0,0],matrix:rt,preDefined:[0,0,0,0,0,0],nextTrackId:r+1},o={type:"tkhd",version:0,flags:3,creationTime:0,modificationTime:0,trackId:r,reserved1:0,duration:0,reserved2:[0,0],layer:0,alternateGroup:0,volume:0,reserved3:0,matrix:rt,width:e*65536,height:n*65536},l={type:"mdhd",version:0,flags:0,creationTime:0,modificationTime:0,timescale:s,duration:0,language:"und",preDefined:0},d={type:"hdlr",version:0,flags:0,preDefined:0,handlerType:"vide",reserved:[0,0,0],name:"VideoHandler"},h={type:"vmhd",version:0,flags:1,graphicsmode:0,opcolor:[0,0,0]},y={type:"dinf",boxes:[{type:"dref",version:0,flags:0,entryCount:1,entries:[{type:"url ",version:0,flags:1,location:""}]}]},b={type:"stsd",version:0,flags:0,entryCount:1,entries:[Ln(e,n,D(i))]},v={type:"stts",version:0,flags:0,entryCount:0,entries:[]},S=re(),j=ae(),L=oe(),ft=et([a,{type:"moov",boxes:[c,{type:"trak",boxes:[o,{type:"mdia",boxes:[l,d,{type:"minf",boxes:[h,y,{type:"stbl",boxes:[b,v,S,j,L]}]}]}]},{type:"mvex",boxes:[{type:"trex",version:0,flags:0,trackId:r,defaultSampleDescriptionIndex:1,defaultSampleDuration:0,defaultSampleSize:0,defaultSampleFlags:0}]}]}]),nt=ft.reduce((I,_)=>I+_.byteLength,0),it=new Uint8Array(nt);let K=0;for(const I of ft)it.set(new Uint8Array(I.buffer,I.byteOffset,I.byteLength),K),K+=I.byteLength;return it}function _n(t){const{sampleRate:e,numberOfChannels:n,description:i,codec:s}=t,r=1e6,a=1,c={type:"ftyp",majorBrand:"isom",minorVersion:512,compatibleBrands:["isom","iso6","mp41"]},o={type:"mvhd",version:0,flags:0,creationTime:0,modificationTime:0,timescale:r,duration:0,rate:65536,volume:256,reserved1:0,reserved2:[0,0],matrix:rt,preDefined:[0,0,0,0,0,0],nextTrackId:a+1},l={type:"tkhd",version:0,flags:3,creationTime:0,modificationTime:0,trackId:a,reserved1:0,duration:0,reserved2:[0,0],layer:0,alternateGroup:0,volume:256,reserved3:0,matrix:rt,width:0,height:0},d={type:"mdhd",version:0,flags:0,creationTime:0,modificationTime:0,timescale:r,duration:0,language:"und",preDefined:0},h={type:"hdlr",version:0,flags:0,preDefined:0,handlerType:"soun",reserved:[0,0,0],name:"SoundHandler"},m={type:"smhd",version:0,flags:0,balance:0,reserved:0},w={type:"dinf",boxes:[{type:"dref",version:0,flags:0,entryCount:1,entries:[{type:"url ",version:0,flags:1,location:""}]}]},v={type:"stsd",version:0,flags:0,entryCount:1,entries:[Fn(s,e,n,i)]},S={type:"stts",version:0,flags:0,entryCount:0,entries:[]},j=re(),L=ae(),P=oe(),nt=et([c,{type:"moov",boxes:[o,{type:"trak",boxes:[l,{type:"mdia",boxes:[d,h,{type:"minf",boxes:[m,w,{type:"stbl",boxes:[v,S,j,L,P]}]}]}]},{type:"mvex",boxes:[{type:"trex",version:0,flags:0,trackId:a,defaultSampleDescriptionIndex:1,defaultSampleDuration:0,defaultSampleSize:0,defaultSampleFlags:0}]}]}]),it=nt.reduce((_,ye)=>_+ye.byteLength,0),K=new Uint8Array(it);let I=0;for(const _ of nt)K.set(new Uint8Array(_.buffer,_.byteOffset,_.byteLength),I),I+=_.byteLength;return K}function Fn(t,e,n,i){if(t.startsWith("mp4a"))return On(e,n,i);if(t==="opus")return Nn(e,n,i);throw new Error(`Unsupported audio codec: ${t}`)}function On(t,e,n){const i=jn(t,e,n),r=8+(28+i.length),a=new Uint8Array(r),c=new DataView(a.buffer);let o=0;return c.setUint32(o,r,!1),o+=4,a[o++]=109,a[o++]=112,a[o++]=52,a[o++]=97,o+=6,c.setUint16(o,1,!1),o+=2,o+=8,c.setUint16(o,e,!1),o+=2,c.setUint16(o,16,!1),o+=2,c.setUint16(o,0,!1),o+=2,c.setUint16(o,0,!1),o+=2,c.setUint32(o,t*65536,!1),o+=4,a.set(i,o),a}function Nn(t,e,n){const i=Pn(e,t,n),r=8+(28+i.length),a=new Uint8Array(r),c=new DataView(a.buffer);let o=0;return c.setUint32(o,r,!1),o+=4,a[o++]=79,a[o++]=112,a[o++]=117,a[o++]=115,o+=6,c.setUint16(o,1,!1),o+=2,o+=8,c.setUint16(o,e,!1),o+=2,c.setUint16(o,16,!1),o+=2,c.setUint16(o,0,!1),o+=2,c.setUint16(o,0,!1),o+=2,c.setUint32(o,t*65536,!1),o+=4,a.set(i,o),a}function jn(t,e,n){const i=n?D(n):In(t,e),s=i.length,r=15+s,a=5+r+3,c=14+a,o=new Uint8Array(c),l=new DataView(o.buffer);let d=0;return l.setUint32(d,c,!1),d+=4,o[d++]=101,o[d++]=115,o[d++]=100,o[d++]=115,l.setUint32(d,0,!1),d+=4,o[d++]=3,o[d++]=a,l.setUint16(d,0,!1),d+=2,o[d++]=0,o[d++]=4,o[d++]=r,o[d++]=64,o[d++]=21,o[d++]=0,o[d++]=0,o[d++]=0,l.setUint32(d,0,!1),d+=4,l.setUint32(d,0,!1),d+=4,o[d++]=5,o[d++]=s,o.set(i,d),d+=s,o[d++]=6,o[d++]=1,o[d++]=2,o}function Pn(t,e,n){if(n){const c=D(n),o=8+c.length,l=new Uint8Array(o);return new DataView(l.buffer).setUint32(0,o,!1),l[4]=100,l[5]=79,l[6]=112,l[7]=115,l.set(c,8),l}const i=19,s=new Uint8Array(i),r=new DataView(s.buffer);let a=0;return r.setUint32(a,i,!1),a+=4,s[a++]=100,s[a++]=79,s[a++]=112,s[a++]=115,s[a++]=0,s[a++]=t,r.setUint16(a,312,!1),a+=2,r.setUint32(a,e,!1),a+=4,r.setInt16(a,0,!1),a+=2,s[a++]=0,s}function ce(t){const{data:e,timestamp:n,duration:i,keyframe:s,sequence:r,trackId:a=1}=t,c=s?33554432:16842752,o={type:"mfhd",version:0,flags:0,sequenceNumber:r},l={type:"tfhd",version:0,flags:131072,trackId:a},d={type:"tfdt",version:1,flags:0,baseMediaDecodeTime:n},h={type:"trun",version:0,flags:1793,sampleCount:1,dataOffset:0,samples:[{sampleDuration:i,sampleSize:e.byteLength,sampleFlags:c}]},p={type:"moof",boxes:[o,{type:"traf",boxes:[l,d,h]}]},y=et([p]);let w=0;for(const A of y)w+=A.byteLength;h.dataOffset=w+8;const b=et([p]);w=0;for(const A of b)w+=A.byteLength;const v=new ArrayBuffer(e.byteLength),S=new Uint8Array(v);S.set(e);const L=et([{type:"mdat",data:S}]);let P=0;for(const A of L)P+=A.byteLength;const V=new Uint8Array(w+P);let R=0;for(const A of b)V.set(new Uint8Array(A.buffer,A.byteOffset,A.byteLength),R),R+=A.byteLength;for(const A of L)V.set(new Uint8Array(A.buffer,A.byteOffset,A.byteLength),R),R+=A.byteLength;return V}let le=class{#t;constructor(e){this.#t=e}decode(e){return zn(e,this.#t).map(n=>({data:n.data,timestamp:n.timestamp,keyframe:n.keyframe}))}};class Y{#t;#e;#i;#n=[];#s;#r;#a=new f([]);buffered=this.#a;#o=new x;constructor(e,n){this.#t=e,this.#e=n.format,this.#i=f.from(n.latency??u.zero),this.#o.spawn(this.#c.bind(this)),this.#o.cleanup(()=>{this.#t.close();for(const i of this.#n)i.consumer.close();this.#n.length=0})}async#c(){for(;;){const e=await this.#t.recvGroup();if(!e)break;if(this.#s===void 0&&(this.#s=e.sequence),e.sequence<this.#s){console.warn(`skipping old group: ${e.sequence} < ${this.#s}`),e.close();continue}const n={consumer:e,frames:[]};this.#n.push(n),this.#n.sort((i,s)=>i.consumer.sequence-s.consumer.sequence),this.#o.spawn(this.#l.bind(this,n))}}async#l(e){try{let n=0;for(;;){const i=await e.consumer.readFrame();if(!i)break;const s=globalThis.__VIVOH_MEDIA_CRYPTO__;let r=i;if(s&&s.shouldDecrypt())try{r=await s.beforeDecode(i)}catch(c){console.error("[media-crypto] decrypt failed; dropping frame",c);continue}const a=this.#e.decode(r);for(const c of a){const o={data:c.data,timestamp:c.timestamp,keyframe:n===0?!0:c.keyframe};n++,e.frames.push(o),(e.latest===void 0||o.timestamp>e.latest)&&(e.latest=o.timestamp),this.#d(),e.consumer.sequence===this.#s?(this.#r?.(),this.#r=void 0):this.#f()}}}catch{}finally{e.done=!0,e.consumer.sequence===this.#s&&(this.#s+=1),this.#d(),this.#r?.(),this.#r=void 0,e.consumer.close()}}#f(){if(this.#s===void 0)return;let e=!1;for(;this.#n.length>=2;){const n=ct.fromMilli(this.#i.peek());let i,s;for(const c of this.#n){if(c.latest===void 0)continue;const o=c.frames.at(0)?.timestamp??c.latest;(i===void 0||o<i)&&(i=o),(s===void 0||c.latest>s)&&(s=c.latest)}if(i===void 0||s===void 0||s-i<=n)break;const a=this.#n.shift();if(!a)break;this.#s=this.#n[0]?.consumer.sequence,console.warn(`skipping slow group: ${a.consumer.sequence} -> ${this.#s}`),a.consumer.close(),a.frames.length=0,e=!0}e&&(this.#d(),this.#r?.(),this.#r=void 0)}async next(){for(;;){if(this.#n.length>0&&this.#s!==void 0&&this.#n[0].consumer.sequence<=this.#s){const i=this.#n[0].frames.shift();if(i)return this.#d(),{frame:i,group:this.#n[0].consumer.sequence};if(this.#s>this.#n[0].consumer.sequence||this.#n[0].done){this.#n[0].consumer.sequence===this.#s&&(this.#s+=1);const s=this.#n.shift();if(s)return this.#d(),{frame:void 0,group:s.consumer.sequence}}}if(this.#r)throw new Error("multiple calls to next not supported");const e=this.#o.abort;if(e.aborted)return;const n=await new Promise(i=>{const s=()=>i(!0);e.addEventListener("abort",s,{once:!0}),this.#r=()=>{e.removeEventListener("abort",s),i(!1)}});if(this.#r=void 0,n)return}}#d(){const e=[];let n;for(const i of this.#n){const s=i.frames.at(0);if(!s||i.latest===void 0)continue;const r=u.fromMicro(s.timestamp),a=u.fromMicro(i.latest),c=e.at(-1),o=n?.done&&n.consumer.sequence+1===i.consumer.sequence;c&&(c.end>=r||o)?c.end=u.max(c.end,a):e.push({start:r,end:a}),n=i}this.#a.set(e)}close(){this.#o.close()}}class dt{decode(e){const[n,i]=Z(e);return[{data:i,timestamp:n,keyframe:!1}]}}function at(t,e){if(t.length===0)return e;if(e.length===0)return t;const n=[],i=[...t,...e].sort((s,r)=>s.start-r.start);for(const s of i){const r=n.at(-1);r&&r.end>=s.start?r.end=u.max(r.end,s.end):n.push({...s})}return n}let ht;async function Ft(){return globalThis.AudioEncoder&&globalThis.AudioDecoder?!0:(ht||(console.warn("using Opus polyfill; performance may be degraded"),ht=Promise.all([kt(()=>import("./libav-opus-af-DmS5HvLr.js"),[],import.meta.url),kt(()=>import("./index-DqahU7yv.js").then(t=>t.m),[],import.meta.url)]).then(async([t,e])=>(await e.load({LibAV:t,polyfill:!0}),!0))),await ht)}const Vn=ot([Gt(["loc","cmaf","legacy","mediatimeline","eventtimeline"]),T()]),Wn=ot([Gt(["video","audio","audiodescription","caption","subtitle","signlanguage"]),T()]),$n=M({name:T(),packaging:Vn,isLive:wt(),role:g(Wn),codec:g(T()),width:g(z()),height:g(z()),framerate:g(z()),samplerate:g(z()),channelConfig:g(T()),bitrate:g(z()),initData:g(T()),renderGroup:g(z()),altGroup:g(z()),jitter:g(z())}),qn=M({version:st(1),tracks:Yt($n)});function Hn(t){const n=new TextDecoder().decode(t);try{const i=JSON.parse(n);return qn.parse(i)}catch(i){throw console.warn("invalid MSF catalog",n),i}}async function Xn(t){const e=await t.readFrame();if(e)return Hn(e)}function $(t){let e=atob(t),n=new Uint8Array(e.length);for(let i=0;i<e.length;i++)n[i]=e.charCodeAt(i);return n}var F=0,B=1,J=2,q=3,Yn=4;function de(t,e,n){if(t<=0)throw Error("invalid channels");if(e<=0)throw Error("invalid capacity");if(n<=0)throw Error("invalid sample rate");let i=new SharedArrayBuffer(t*e*Float32Array.BYTES_PER_ELEMENT),s=new SharedArrayBuffer(Yn*Int32Array.BYTES_PER_ELEMENT),r=new Int32Array(s);return Atomics.store(r,q,1),{channels:t,capacity:e,rate:n,samples:i,control:s}}function Gn(t,e){return(t-e|0)>0?t:e}function Q(t,e){return(t%e+e)%e}function mt(t,e,n){for(;;){let i=Atomics.load(t,e);if((n-i|0)<=0)return i;if(Atomics.compareExchange(t,e,i,n)===i)return n}}var Kn=class fe{channels;capacity;rate;init;#t;#e;constructor(e){this.channels=e.channels,this.capacity=e.capacity,this.rate=e.rate,this.init=e,this.#t=new Int32Array(e.control),this.#e=[];for(let n=0;n<this.channels;n++)this.#e.push(new Float32Array(e.samples,n*this.capacity*Float32Array.BYTES_PER_ELEMENT,this.capacity))}insert(e,n){if(n.length!==this.channels)throw Error("wrong number of channels");let i=Math.round(gt.fromMicro(e)*this.rate),s=n[0].length,r=0,a=i+s|0,c=Atomics.load(this.#t,B),o=c-i|0;if(o>0){if(o>=s)return;r=o,i=i+o|0}let l=s-r;(a-c|0)>this.capacity&&mt(this.#t,B,a-this.capacity|0);let d=Atomics.load(this.#t,F),h=i-d|0;if(h>0){let w=Math.min(h,this.capacity);for(let b=0;b<this.channels;b++){let v=this.#e[b];for(let S=0;S<w;S++)v[Q(d+S|0,this.capacity)]=0}}for(let w=0;w<this.channels;w++){let b=n[w],v=this.#e[w];for(let S=0;S<l;S++)v[Q(i+S|0,this.capacity)]=b[r+S]}Atomics.store(this.#t,F,Gn(Atomics.load(this.#t,F),a));let m=Atomics.load(this.#t,B),p=Atomics.load(this.#t,F),y=Atomics.load(this.#t,J);(p-m|0)>=y&&y>0&&Atomics.store(this.#t,q,0)}read(e){if(Atomics.load(this.#t,q)===1)return 0;let n=Atomics.load(this.#t,B),i=Atomics.load(this.#t,F),s=Atomics.load(this.#t,J),r=i-n|0;if(s>0&&r>s){let o=i-s|0;n=mt(this.#t,B,o)}let a=i-n|0,c=Math.min(a,e[0].length);if(c<=0)return 0;for(let o=0;o<this.channels;o++){let l=this.#e[o],d=e[o];for(let h=0;h<c;h++)d[h]=l[Q(n+h|0,this.capacity)]}return mt(this.#t,B,n+c|0),c}setLatency(e){Atomics.store(this.#t,J,e)}resize(e){let n=new fe(de(this.channels,e,this.rate)),i=Atomics.load(this.#t,B),s=Atomics.load(this.#t,F),r=Atomics.load(this.#t,J),a=Atomics.load(this.#t,q),c=s-i|0,o=Math.max(0,Math.min(c,n.capacity)),l=s-o|0;for(let d=0;d<this.channels;d++){let h=this.#e[d],m=n.#e[d];for(let p=0;p<o;p++){let y=l+p|0;m[Q(y,n.capacity)]=h[Q(y,this.capacity)]}}return Atomics.store(n.#t,B,l),Atomics.store(n.#t,F,s),Atomics.store(n.#t,J,r),Atomics.store(n.#t,q,a),n}get timestamp(){let e=Atomics.load(this.#t,B);return ct.fromSecond(e/this.rate)}get stalled(){return Atomics.load(this.#t,q)===1}get length(){return Atomics.load(this.#t,F)-Atomics.load(this.#t,B)|0}};function Jn(){return!(typeof SharedArrayBuffer>"u"||typeof crossOriginIsolated<"u"&&!crossOriginIsolated)}function Qn(t,e,n,i){return Jn()?(console.log("[audio] using SharedArrayBuffer audio buffer"),new Zn(t,e,n,i)):(console.log("[audio] using postMessage audio buffer (SharedArrayBuffer unavailable)"),new ti(t,e,n,i))}var Zn=class{rate;channels;#t;#e;#i=new f(0);timestamp=this.#i;#n=new f(!0);stalled=this.#n;#s=new x;constructor(t,e,n,i){this.#t=t,this.channels=e,this.rate=n;let s=de(e,Math.max(n,i*2),n);this.#e=new Kn(s),this.#e.setLatency(i);let r={type:"init-shared",...s};t.port.postMessage(r),this.#s.interval(()=>{this.#i.set(this.#e.timestamp),this.#n.set(this.#e.stalled)},50)}insert(t,e){this.#e.insert(t,e)}setLatency(t){if(this.#e.capacity<t*1.5){let e=Math.max(this.rate,t*2);this.#e=this.#e.resize(e),this.#e.setLatency(t);let n={type:"init-shared",...this.#e.init};this.#t.port.postMessage(n)}else this.#e.setLatency(t)}close(){this.#s.close()}},ti=class{rate;channels;#t;#e=new f(0);timestamp=this.#e;#i=new f(!0);stalled=this.#i;#n=new x;constructor(t,e,n,i){this.#t=t,this.channels=e,this.rate=n;let s={type:"init-post",channels:e,rate:n,latency:u.fromSecond(i/n)};t.port.postMessage(s),this.#n.event(t.port,"message",r=>{let a=r.data;a?.type==="state"&&(this.#e.set(a.timestamp),this.#i.set(a.stalled))}),t.port.start()}insert(t,e){let n={type:"data",data:e,timestamp:t};this.#t.port.postMessage(n,e.map(i=>i.buffer))}setLatency(t){let e={type:"latency",latency:u.fromSecond(t/this.rate)};this.#t.port.postMessage(e)}close(){this.#n.close()}},ei=new Blob([`var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../net/src/path.ts
var init_path = __esm({
  "../net/src/path.ts"() {
    "use strict";
  }
});

// ../net/src/varint.ts
var MAX_U6, MAX_U14, MAX_U30, MAX_U53, MAX_U64, MAX_U62;
var init_varint = __esm({
  "../net/src/varint.ts"() {
    "use strict";
    MAX_U6 = 2 ** 6 - 1;
    MAX_U14 = 2 ** 14 - 1;
    MAX_U30 = 2 ** 30 - 1;
    MAX_U53 = Number.MAX_SAFE_INTEGER;
    MAX_U64 = (1n << 64n) - 1n;
    MAX_U62 = 2n ** 62n - 1n;
  }
});

// ../net/src/index.ts
init_path();

// ../net/src/time.ts
var time_exports = {};
__export(time_exports, {
  Micro: () => Micro,
  Milli: () => Milli,
  Nano: () => Nano,
  Second: () => Second
});
var Nano = {
  zero: 0,
  fromMicro: (us) => us * 1e3,
  fromMilli: (ms) => ms * 1e6,
  fromSecond: (s) => s * 1e9,
  toMicro: (ns) => ns / 1e3,
  toMilli: (ns) => ns / 1e6,
  toSecond: (ns) => ns / 1e9,
  now: () => performance.now() * 1e6,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b)
};
var Micro = {
  zero: 0,
  fromNano: (ns) => ns / 1e3,
  fromMilli: (ms) => ms * 1e3,
  fromSecond: (s) => s * 1e6,
  toNano: (us) => us * 1e3,
  toMilli: (us) => us / 1e3,
  toSecond: (us) => us / 1e6,
  now: () => performance.now() * 1e3,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b)
};
var Milli = {
  zero: 0,
  fromNano: (ns) => ns / 1e6,
  fromMicro: (us) => us / 1e3,
  fromSecond: (s) => s * 1e3,
  toNano: (ms) => ms * 1e6,
  toMicro: (ms) => ms * 1e3,
  toSecond: (ms) => ms / 1e3,
  now: () => performance.now(),
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b)
};
var Second = {
  zero: 0,
  fromNano: (ns) => ns / 1e9,
  fromMicro: (us) => us / 1e6,
  fromMilli: (ms) => ms / 1e3,
  toNano: (s) => s * 1e9,
  toMicro: (s) => s * 1e6,
  toMilli: (s) => s * 1e3,
  now: () => performance.now() / 1e3,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b)
};

// ../net/src/index.ts
init_varint();

// src/audio/ring-buffer.ts
var AudioRingBuffer = class {
  #buffer;
  #writeIndex = 0;
  #readIndex = 0;
  rate;
  channels;
  #stalled = true;
  constructor(props) {
    if (props.channels <= 0) throw new Error("invalid channels");
    if (props.rate <= 0) throw new Error("invalid sample rate");
    if (props.latency <= 0) throw new Error("invalid latency");
    const samples = Math.ceil(props.rate * time_exports.Second.fromMilli(props.latency));
    if (samples === 0) throw new Error("empty buffer");
    this.rate = props.rate;
    this.channels = props.channels;
    this.#buffer = [];
    for (let i = 0; i < this.channels; i++) {
      this.#buffer[i] = new Float32Array(samples);
    }
  }
  get stalled() {
    return this.#stalled;
  }
  get timestamp() {
    return time_exports.Micro.fromSecond(this.#readIndex / this.rate);
  }
  get length() {
    return this.#writeIndex - this.#readIndex;
  }
  get capacity() {
    return this.#buffer[0]?.length;
  }
  resize(latency) {
    const newCapacity = Math.ceil(this.rate * time_exports.Second.fromMilli(latency));
    if (newCapacity === this.capacity) return;
    if (newCapacity === 0) throw new Error("empty buffer");
    const newBuffer = [];
    for (let i = 0; i < this.channels; i++) {
      newBuffer[i] = new Float32Array(newCapacity);
    }
    const samplesToKeep = Math.min(this.length, newCapacity);
    if (samplesToKeep > 0) {
      const copyStart = this.#writeIndex - samplesToKeep;
      for (let channel = 0; channel < this.channels; channel++) {
        const src = this.#buffer[channel];
        const dst = newBuffer[channel];
        for (let i = 0; i < samplesToKeep; i++) {
          const srcPos = (copyStart + i) % src.length;
          const dstPos = (copyStart + i) % dst.length;
          dst[dstPos] = src[srcPos];
        }
      }
    }
    this.#buffer = newBuffer;
    this.#readIndex = this.#writeIndex - samplesToKeep;
    if (samplesToKeep === 0) this.#stalled = true;
  }
  write(timestamp, data) {
    if (data.length !== this.channels) throw new Error("wrong number of channels");
    let start = Math.round(time_exports.Second.fromMicro(timestamp) * this.rate);
    let samples = data[0].length;
    let offset = this.#readIndex - start;
    if (offset > samples) {
      return;
    } else if (offset > 0) {
      samples -= offset;
      start += offset;
    } else {
      offset = 0;
    }
    const end = start + samples;
    const overflow = end - this.#readIndex - this.#buffer[0].length;
    if (overflow >= 0) {
      this.#stalled = false;
      this.#readIndex += overflow;
    }
    if (start > this.#writeIndex) {
      const gapSize = Math.min(start - this.#writeIndex, this.#buffer[0].length);
      if (gapSize === 1) {
        console.warn("floating point inaccuracy detected");
      }
      for (let channel = 0; channel < this.channels; channel++) {
        const dst = this.#buffer[channel];
        for (let i = 0; i < gapSize; i++) {
          const writePos = (this.#writeIndex + i) % dst.length;
          dst[writePos] = 0;
        }
      }
    }
    for (let channel = 0; channel < this.channels; channel++) {
      let src = data[channel];
      src = src.subarray(src.length - samples);
      const dst = this.#buffer[channel];
      if (src.length !== samples) throw new Error("mismatching number of samples");
      for (let i = 0; i < samples; i++) {
        const writePos = (start + i) % dst.length;
        dst[writePos] = src[i];
      }
    }
    if (end > this.#writeIndex) {
      this.#writeIndex = end;
    }
  }
  read(output) {
    if (output.length !== this.channels) throw new Error("wrong number of channels");
    if (this.#stalled) return 0;
    const samples = Math.min(this.#writeIndex - this.#readIndex, output[0].length);
    if (samples === 0) return 0;
    for (let channel = 0; channel < this.channels; channel++) {
      const dst = output[channel];
      const src = this.#buffer[channel];
      if (dst.length !== output[0].length) throw new Error("mismatching number of samples");
      for (let i = 0; i < samples; i++) {
        const readPos = (this.#readIndex + i) % src.length;
        dst[i] = src[readPos];
      }
    }
    this.#readIndex += samples;
    return samples;
  }
};

// src/audio/shared-ring-buffer.ts
var WRITE = 0;
var READ = 1;
var LATENCY = 2;
var STALLED = 3;
var CONTROL_SLOTS = 4;
function allocSharedRingBuffer(channels, capacity, rate) {
  if (channels <= 0) throw new Error("invalid channels");
  if (capacity <= 0) throw new Error("invalid capacity");
  if (rate <= 0) throw new Error("invalid sample rate");
  const samples = new SharedArrayBuffer(channels * capacity * Float32Array.BYTES_PER_ELEMENT);
  const control = new SharedArrayBuffer(CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT);
  const ctrl = new Int32Array(control);
  Atomics.store(ctrl, STALLED, 1);
  return { channels, capacity, rate, samples, control };
}
function i32Max(a, b) {
  return (a - b | 0) > 0 ? a : b;
}
function slot(idx, capacity) {
  return (idx % capacity + capacity) % capacity;
}
function casAdvance(arr, idx, candidate) {
  for (; ; ) {
    const current = Atomics.load(arr, idx);
    if ((candidate - current | 0) <= 0) return current;
    const witnessed = Atomics.compareExchange(arr, idx, current, candidate);
    if (witnessed === current) return candidate;
  }
}
var SharedRingBuffer = class _SharedRingBuffer {
  channels;
  capacity;
  rate;
  init;
  #control;
  #samples;
  constructor(init) {
    this.channels = init.channels;
    this.capacity = init.capacity;
    this.rate = init.rate;
    this.init = init;
    this.#control = new Int32Array(init.control);
    this.#samples = [];
    for (let i = 0; i < this.channels; i++) {
      this.#samples.push(
        new Float32Array(init.samples, i * this.capacity * Float32Array.BYTES_PER_ELEMENT, this.capacity)
      );
    }
  }
  /**
   * Insert audio samples at the given timestamp.
   * Main thread only. Handles out-of-order writes, gap filling, and overflow.
   */
  insert(timestamp, data) {
    if (data.length !== this.channels) throw new Error("wrong number of channels");
    let start = Math.round(time_exports.Second.fromMicro(timestamp) * this.rate);
    const originalLength = data[0].length;
    let offset = 0;
    const end = start + originalLength | 0;
    const read = Atomics.load(this.#control, READ);
    const behind = read - start | 0;
    if (behind > 0) {
      if (behind >= originalLength) {
        return;
      }
      offset = behind;
      start = start + behind | 0;
    }
    const samples = originalLength - offset;
    if ((end - read | 0) > this.capacity) {
      casAdvance(this.#control, READ, end - this.capacity | 0);
    }
    const write = Atomics.load(this.#control, WRITE);
    const gap = start - write | 0;
    if (gap > 0) {
      const gapSize = Math.min(gap, this.capacity);
      for (let channel = 0; channel < this.channels; channel++) {
        const dst = this.#samples[channel];
        for (let i = 0; i < gapSize; i++) {
          dst[slot(write + i | 0, this.capacity)] = 0;
        }
      }
    }
    for (let channel = 0; channel < this.channels; channel++) {
      const src = data[channel];
      const dst = this.#samples[channel];
      for (let i = 0; i < samples; i++) {
        dst[slot(start + i | 0, this.capacity)] = src[offset + i];
      }
    }
    Atomics.store(this.#control, WRITE, i32Max(Atomics.load(this.#control, WRITE), end));
    const currentRead = Atomics.load(this.#control, READ);
    const currentWrite = Atomics.load(this.#control, WRITE);
    const latency = Atomics.load(this.#control, LATENCY);
    if ((currentWrite - currentRead | 0) >= latency && latency > 0) {
      Atomics.store(this.#control, STALLED, 0);
    }
  }
  /**
   * Read audio samples into the output buffers.
   * AudioWorklet only. Returns the number of samples read.
   */
  read(output) {
    if (Atomics.load(this.#control, STALLED) === 1) return 0;
    let read = Atomics.load(this.#control, READ);
    const write = Atomics.load(this.#control, WRITE);
    const latency = Atomics.load(this.#control, LATENCY);
    const buffered = write - read | 0;
    if (latency > 0 && buffered > latency) {
      const skipTo = write - latency | 0;
      read = casAdvance(this.#control, READ, skipTo);
    }
    const available = write - read | 0;
    const count = Math.min(available, output[0].length);
    if (count <= 0) return 0;
    for (let channel = 0; channel < this.channels; channel++) {
      const src = this.#samples[channel];
      const dst = output[channel];
      for (let i = 0; i < count; i++) {
        dst[i] = src[slot(read + i | 0, this.capacity)];
      }
    }
    casAdvance(this.#control, READ, read + count | 0);
    return count;
  }
  /** Update the target latency in samples. */
  setLatency(samples) {
    Atomics.store(this.#control, LATENCY, samples);
  }
  /**
   * Allocate a new ring with \`newCapacity\` samples and copy the unread window
   * [READ, WRITE) plus control state into it. Used when growing capacity so
   * we don't drop buffered audio. If \`newCapacity\` is smaller than the unread
   * span, the oldest samples are truncated.
   *
   * Main thread only. \`resize()\` reads from the source \`SharedRingBuffer\` and
   * writes into a freshly allocated buffer from \`allocSharedRingBuffer\`, so it
   * relies on the same invariant as \`insert()\`: no concurrent main-thread
   * writers. The AudioWorklet reader is tolerated via the CAS discipline used
   * by READ/WRITE elsewhere.
   */
  resize(newCapacity) {
    const init = allocSharedRingBuffer(this.channels, newCapacity, this.rate);
    const dst = new _SharedRingBuffer(init);
    const read = Atomics.load(this.#control, READ);
    const write = Atomics.load(this.#control, WRITE);
    const latency = Atomics.load(this.#control, LATENCY);
    const stalled = Atomics.load(this.#control, STALLED);
    const available = write - read | 0;
    const copyCount = Math.max(0, Math.min(available, dst.capacity));
    const copyStart = write - copyCount | 0;
    for (let channel = 0; channel < this.channels; channel++) {
      const src = this.#samples[channel];
      const out = dst.#samples[channel];
      for (let i = 0; i < copyCount; i++) {
        const idx = copyStart + i | 0;
        out[slot(idx, dst.capacity)] = src[slot(idx, this.capacity)];
      }
    }
    Atomics.store(dst.#control, READ, copyStart);
    Atomics.store(dst.#control, WRITE, write);
    Atomics.store(dst.#control, LATENCY, latency);
    Atomics.store(dst.#control, STALLED, stalled);
    return dst;
  }
  /** Current playback timestamp derived from READ position. */
  get timestamp() {
    const read = Atomics.load(this.#control, READ);
    return time_exports.Micro.fromSecond(read / this.rate);
  }
  /** Whether the buffer is stalled (waiting to fill). */
  get stalled() {
    return Atomics.load(this.#control, STALLED) === 1;
  }
  /**
   * Number of buffered samples (WRITE - READ).
   *
   * Non-atomic: WRITE and READ are loaded separately, so a concurrent
   * writer/reader can make the two loads inconsistent. Intended for
   * tests and diagnostics, not control-flow decisions.
   */
  get length() {
    return Atomics.load(this.#control, WRITE) - Atomics.load(this.#control, READ) | 0;
  }
};

// src/audio/render-worklet.ts
var Render = class extends AudioWorkletProcessor {
  // Set after init, depending on which path the main thread chose.
  #backend;
  #underflow = 0;
  #stateCounter = 0;
  constructor() {
    super();
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "init-shared") {
        console.log("[audio-worklet] init-shared: using SharedArrayBuffer path");
        this.#backend = new SharedRingBuffer(msg);
        this.#underflow = 0;
      } else if (msg.type === "init-post") {
        console.log("[audio-worklet] init-post: using postMessage path");
        this.#backend = new AudioRingBuffer(msg);
        this.#underflow = 0;
      } else if (msg.type === "data") {
        if (this.#backend instanceof AudioRingBuffer) this.#backend.write(msg.timestamp, msg.data);
      } else if (msg.type === "latency") {
        if (this.#backend instanceof AudioRingBuffer) this.#backend.resize(msg.latency);
      }
    };
  }
  process(_inputs, outputs, _parameters) {
    const output = outputs[0];
    const backend = this.#backend;
    const samplesRead = backend?.read(output) ?? 0;
    if (samplesRead < output[0].length) {
      this.#underflow += output[0].length - samplesRead;
    } else if (this.#underflow > 0 && backend) {
      console.debug(\`audio underflow: \${Math.round(1e3 * this.#underflow / backend.rate)}ms\`);
      this.#underflow = 0;
    }
    if (backend instanceof AudioRingBuffer) {
      this.#stateCounter++;
      if (this.#stateCounter >= 5) {
        this.#stateCounter = 0;
        const state = {
          type: "state",
          timestamp: backend.timestamp,
          stalled: backend.stalled
        };
        this.port.postMessage(state);
      }
    }
    return true;
  }
};
registerProcessor("render", Render);
`],{type:"application/javascript"}),ni=URL.createObjectURL(ei),ii=class{source;enabled;#t=new f(void 0);context=this.#t;#e=new f(void 0);root=this.#e;#i=new f(void 0);sampleRate=this.#i;#n=new f(void 0);stats=this.#n;#s=new f(void 0);timestamp=this.#s;#r=new f(!0);stalled=this.#r;#a=new f([]);#o=new f([]);buffered=this.#o;#c;#l=new x;constructor(t,e){this.source=t,this.source.supported.set(si),this.enabled=f.from(e?.enabled??!1),this.#l.run(this.#f.bind(this)),this.#l.run(this.#d.bind(this)),this.#l.run(this.#u.bind(this)),this.#l.run(this.#m.bind(this))}#f(t){let e=t.get(this.source.config);if(!e)return;let n=e.sampleRate,i=e.numberOfChannels,s=new AudioContext({latencyHint:"interactive",sampleRate:n});t.set(this.#t,s),t.cleanup(()=>s.close()),t.spawn(async()=>{if(await s.audioWorklet.addModule(ni),s.state==="closed")return;let r=new AudioWorkletNode(s,"render",{channelCount:i,channelCountMode:"explicit",outputChannelCount:[i]});t.cleanup(()=>r.disconnect());let a=this.source.sync.buffer.peek(),c=Qn(r,i,n,Math.ceil(n*gt.fromMilli(a)));this.#c=c,t.cleanup(()=>{c.close(),this.#c=void 0}),t.run(o=>{let l=u.fromMicro(o.get(c.timestamp));this.#s.set(l),this.#y(l)}),t.run(o=>{this.#r.set(o.get(c.stalled))}),t.set(this.#e,r)})}#d(t){let e=t.getAll([this.enabled,this.#t]);if(!e)return;let[n,i]=e;i.resume()}#u(t){if(!t.get(this.#e))return;let e=this.#c;if(!e)return;let n=t.get(this.source.sync.buffer),i=Math.ceil(e.rate*gt.fromMilli(n));e.setLatency(i)}#m(t){if(!t.get(this.enabled))return;let e=t.get(this.source.broadcast);if(!e)return;let n=t.get(this.source.track);if(!n)return;let i=t.get(this.source.config);if(!i)return;let s=t.get(e.active);if(!s)return;let r=s.subscribe(n,X.audio);t.cleanup(()=>r.close()),i.container.kind==="cmaf"?this.#g(t,r,i):this.#p(t,r,i)}#p(t,e,n){let i=n.container.kind==="loc"?new lt:new dt,s=new Y(e,{format:i,latency:this.source.sync.buffer});t.cleanup(()=>s.close()),t.run(r=>{let a=r.get(s.buffered),c=r.get(this.#a);this.#o.update(()=>at(a,c))}),t.spawn(async()=>{if(!await Ft())return;let r=0,a=new AudioDecoder({output:o=>{if(r++,r<=3){o.close();return}this.#h(o)},error:o=>console.error(o)});t.cleanup(()=>{a.state!=="closed"&&a.close()});let c=n.codec==="opus"?void 0:n.description?D(n.description):void 0;for(a.configure({...n,description:c});;){let o=await s.next();if(!o)break;let{frame:l}=o;if(!l)continue;let d=u.fromMicro(l.timestamp);this.source.sync.received(d,"audio"),this.#n.update(m=>({bytesReceived:(m?.bytesReceived??0)+l.data.byteLength}));let h=new EncodedAudioChunk({type:l.keyframe?"key":"delta",data:l.data,timestamp:l.timestamp});a.decode(h)}})}#g(t,e,n){if(n.container.kind!=="cmaf")return;let i=$(n.container.init),s=G(i),r=n.codec==="opus"?void 0:n.description?D(n.description):s.description,a=new Y(e,{format:new le(s),latency:this.source.sync.buffer});t.cleanup(()=>a.close()),t.run(c=>{let o=c.get(a.buffered),l=c.get(this.#a);this.#o.update(()=>at(o,l))}),t.spawn(async()=>{if(!await Ft())return;let c=new AudioDecoder({output:o=>this.#h(o),error:o=>console.error(o)});for(t.cleanup(()=>{c.state!=="closed"&&c.close()}),c.configure({codec:n.codec,sampleRate:n.sampleRate,numberOfChannels:n.numberOfChannels,description:r});;){let o=await a.next();if(!o)break;let{frame:l}=o;if(!l)continue;let d=u.fromMicro(l.timestamp);if(this.source.sync.received(d,"audio"),this.#n.update(h=>({bytesReceived:(h?.bytesReceived??0)+l.data.byteLength})),c.state==="closed")break;c.decode(new EncodedAudioChunk({type:l.keyframe?"key":"delta",data:l.data,timestamp:l.timestamp}))}})}#h(t){let e=t.timestamp,n=u.fromMicro(e),i=this.#c;if(!i){t.close();return}let s=t.numberOfFrames/t.sampleRate*1e6,r=u.fromMicro(s),a=u.add(n,r);this.#w(n,a);let c=Math.min(t.numberOfChannels,i.channels),o=[];for(let l=0;l<c;l++){let d=new Float32Array(t.numberOfFrames);t.copyTo(d,{format:"f32-planar",planeIndex:l}),o.push(d)}i.insert(e,o),t.close()}#w(t,e){t>e||this.#a.mutate(n=>{for(let i of n)if(t<=i.end+1&&e>=i.start){i.start=u.min(i.start,t),i.end=u.max(i.end,e);return}n.push({start:t,end:e}),n.sort((i,s)=>i.start-s.start)})}#y(t){this.#a.mutate(e=>{for(;e.length>0;){if(e[0].end>=t){e[0].start=u.max(e[0].start,t);break}e.shift()}})}close(){this.#l.close()}};async function si(t){let e;if(t.codec!=="opus"){if(t.description)e=D(t.description);else if(t.container.kind==="cmaf")try{e=G($(t.container.init)).description}catch(n){return console.warn(`audio: malformed CMAF init segment for codec ${t.codec}`,n),!1}}return(await AudioDecoder.isConfigSupported({...t,description:e})).supported??!1}var Ot=.001,pt=.2,ri=class{source;volume;muted;paused;#t=new x;#e=.5;#i=new f(void 0);constructor(t,e){this.source=t,this.volume=f.from(e?.volume??.5),this.muted=f.from(e?.muted??!1),this.paused=f.from(e?.paused??e?.muted??!1),this.#t.run(n=>{n.get(this.muted)?(this.#e=this.volume.peek()||.5,this.volume.set(0)):this.volume.set(this.#e)}),this.#t.run(n=>{let i=!n.get(this.paused)&&!n.get(this.muted);this.source.enabled.set(i)}),this.#t.run(n=>{let i=n.get(this.volume);this.muted.set(i===0)}),this.#t.run(n=>{let i=n.get(this.source.root);if(!i)return;let s=new GainNode(i.context,{gain:n.get(this.volume)});i.connect(s),n.set(this.#i,s),n.run(r=>{r.get(this.source.enabled)&&(s.connect(i.context.destination),r.cleanup(()=>s.disconnect()))})}),this.#t.run(n=>{let i=n.get(this.#i);if(!i)return;n.cleanup(()=>i.gain.cancelScheduledValues(i.context.currentTime));let s=n.get(this.volume);s<Ot?(i.gain.exponentialRampToValueAtTime(Ot,i.context.currentTime+pt),i.gain.setValueAtTime(0,i.context.currentTime+pt+.01)):i.gain.exponentialRampToValueAtTime(s,i.context.currentTime+pt)})}close(){this.#t.close()}},ai=class{element;paused;#t;#e=new f(void 0);mediaSource=this.#e;#i=new x;constructor(t,e){this.element=f.from(e?.element),this.paused=f.from(e?.paused??!1),this.#t=t,this.#i.run(this.#n.bind(this)),this.#i.run(this.#s.bind(this)),this.#i.run(this.#r.bind(this)),this.#i.run(this.#a.bind(this)),this.#i.run(this.#o.bind(this))}#n(t){let e=t.get(this.element);if(!e)return;let n=new MediaSource;e.src=URL.createObjectURL(n),t.cleanup(()=>URL.revokeObjectURL(e.src)),t.event(n,"sourceopen",()=>{t.set(this.#e,n)},{once:!0}),t.event(n,"error",i=>{console.error("[MSE] MediaSource error event:",i)})}#s(t){let e=t.get(this.element);if(!e||t.get(this.paused))return;let n=u.toSecond(t.get(this.#t.buffer));t.interval(()=>{let i=e.buffered;if(i.length===0)return;let s=i.end(i.length-1)-n,r=s-e.currentTime;(r>.1||r<-.1)&&(console.warn("seeking",r>0?"forward":"backward",Math.abs(r).toFixed(3),"seconds"),e.currentTime=s)},100)}#r(t){let e=t.get(this.element);if(!e)return;let n=t.get(this.mediaSource);n&&t.interval(async()=>{for(let i of n.sourceBuffers){for(;i.updating;)await new Promise(s=>i.addEventListener("updateend",s,{once:!0}));e.currentTime>10&&i.remove(0,e.currentTime-10)}},1e3)}#a(t){let e=t.get(this.element);if(!e)return;let n=t.get(this.paused);n&&!e.paused?e.pause():!n&&e.paused&&e.play().catch(i=>{console.error("[MSE] MediaElement play error:",i)})}#o(t){let e=t.get(this.element);if(!e||t.get(this.paused))return;let n=t.get(this.#t.reference);if(n===void 0)return;let i=t.get(this.#t.buffer),s=u.sub(u.sub(u.now(),n),i);e.currentTime=u.toSecond(s)}close(){this.#i.close()}},oi=20,Nt=100,ci=class ue{#t=new f(void 0);reference=this.#t;latency;jitter;audio;video;#e=new f(u.zero);buffer=this.#e;#i;timestamp=new f(void 0);#n=new Map;#s;#r;signals=new x;constructor(e){this.latency=f.from(e?.latency??"real-time"),this.jitter=new f(Nt),this.#s=e?.connection,this.audio=f.from(e?.audio),this.video=f.from(e?.video),this.#i=Promise.withResolvers(),this.signals.run(this.#a.bind(this)),this.signals.run(this.#o.bind(this))}#a(e){let n=e.get(this.latency);if(typeof n=="number"){this.#r=void 0,this.jitter.set(n);return}let i=(this.#s?e.get(this.#s):void 0)?.rtt,s=i?e.get(i):void 0;if(s!==void 0){this.#r=this.#r===void 0?s:Math.min(this.#r,s);let r=Math.max(oi,this.#r*1.25);this.jitter.set(r);return}this.#r=void 0,this.jitter.set(Nt)}#o(e){let n=e.get(this.jitter),i=e.get(this.video)??u.zero,s=e.get(this.audio)??u.zero,r=u.add(u.max(i,s),n);this.#e.set(r),this.#i.resolve(),this.#i=Promise.withResolvers()}received(e,n=""){this.timestamp.update(a=>a===void 0||e>a?e:a);let i=u.now(),s=u.sub(i,e),r=this.#t.peek();if(r!==void 0){let a=u.add(u.sub(r,s),this.#e.peek());if(a<0){let c=this.#n.get(n);c?(c.count++,c.maxMs=Math.max(c.maxMs,-a)):this.#n.set(n,{count:1,maxMs:-a})}else{let c=this.#n.get(n);if(c){let o=n?`sync[${n}]`:"sync",l=ue.#c(c.maxMs);console.debug(`${o}: ${c.count} late frame(s), max ${l} behind`),this.#n.delete(n)}}if(s>=r)return}this.#t.set(s),this.#i.resolve(),this.#i=Promise.withResolvers()}now(){let e=this.#t.peek();if(e!==void 0)return u.sub(u.sub(u.now(),e),this.#e.peek())}async wait(e){if(this.#t.peek()===void 0)throw Error("reference not set; call update() first");for(;;){let n=u.now(),i=u.sub(n,e),s=this.#t.peek();if(s===void 0)return;let r=u.add(u.sub(s,i),this.#e.peek());if(r<=0||r<5)return;let a=new Promise(c=>setTimeout(c,r)).then(()=>!0);if(await Promise.race([this.#i.promise,a]))return}}static#c(e){if(e=Math.round(e),e<1e3)return`${e}ms`;let n=e/1e3;if(n<60)return`${Math.round(n*10)/10}s`;let i=n/60;return`${Math.round(i*10)/10}m`}close(){this.signals.close()}},li=500,di=100,fi=class{enabled;source;#t=new f(void 0);#e=new f(void 0);frame=this.#e;#i=new f(void 0);timestamp=this.#i;#n=new f(void 0);display=this.#n;#s=new f(!1);stalled=this.#s;#r=new f(void 0);stats=this.#r;#a=new f([]);buffered=this.#a;#o=new x;#c(){this.#e.update(t=>{t?.close()}),this.#i.set(void 0)}constructor(t,e){this.enabled=f.from(e?.enabled??!1),this.source=t,this.source.supported.set(hi),this.#o.run(this.#l.bind(this)),this.#o.run(this.#f.bind(this)),this.#o.run(this.#d.bind(this)),this.#o.run(this.#u.bind(this))}#l(t){let e=t.getAll([this.enabled,this.source.broadcast,this.source.track,this.source.config]);if(!e){this.#t.set(void 0);return}let[n,i,s,r]=e,a=t.get(i.active);if(!a){this.#t.set(void 0),this.#c(),this.#a.set([]);return}let c=new ui({source:this.source,broadcast:a,track:s,config:r,stats:this.#r});t.cleanup(()=>c?.close()),t.run(o=>{if(!c)return;let l=o.get(this.#t);if(l){let d=o.get(c.timestamp),h=o.get(l.timestamp);if(!d||h&&h>d+di)return}this.#t.set(c),c=void 0,o.close()})}#f(t){let e=t.get(this.#t);if(!e){this.#a.set([]);return}t.cleanup(()=>e.close()),t.run(n=>{let i=n.get(e.frame);this.#e.update(s=>(s?.close(),i?.clone()))}),t.proxy(this.#i,e.timestamp),t.proxy(this.#a,e.buffered)}#d(t){let e=t.get(this.source.catalog);if(!e)return;let n=e.display;if(n){t.set(this.#n,{width:n.width,height:n.height});return}let i=t.get(this.frame);i&&t.set(this.#n,{width:i.displayWidth,height:i.displayHeight})}#u(t){if(t.get(this.enabled)){if(!t.get(this.frame)){this.#s.set(!0);return}this.#s.set(!1),t.timer(()=>{this.#s.set(!0)},li)}}close(){this.#c(),this.#o.close()}},ui=class{source;broadcast;track;config;stats;timestamp=new f(void 0);frame=new f(void 0);buffered=new f([]);#t=new f([]);signals=new x;constructor(t){let{codedWidth:e,codedHeight:n,...i}=t.config;this.source=t.source,this.broadcast=t.broadcast,this.track=t.track,this.config=i,this.stats=t.stats,this.signals.run(this.#e.bind(this))}#e(t){let e=this.broadcast.subscribe(this.track,X.video);t.cleanup(()=>e.close());let n=new VideoDecoder({output:async i=>{try{let s=u.fromMicro(i.timestamp);if(s<(this.timestamp.peek()??0))return;this.frame.peek()===void 0&&this.frame.set(i.clone());let r=this.source.sync.wait(s).then(()=>!0);if(!await Promise.race([r,t.cancel])||s<(this.timestamp.peek()??0))return;this.timestamp.set(s),this.#r(s),this.frame.update(a=>(a?.close(),i.clone()))}finally{i.close()}},error:i=>{console.error(i),t.close()}});t.cleanup(()=>{n.state!=="closed"&&n.close()}),this.config.container.kind==="cmaf"?this.#n(t,e,n):this.#i(t,e,n)}#i(t,e,n){let i=this.config.container.kind==="loc"?new lt:new dt,s=new Y(e,{format:i,latency:this.source.sync.buffer});t.cleanup(()=>s.close()),t.run(a=>{let c=a.get(s.buffered),o=a.get(this.#t);this.buffered.update(()=>at(c,o))}),n.configure({...this.config,description:this.config.description?D(this.config.description):void 0,optimizeForLatency:this.config.optimizeForLatency??!0,flip:!1});let r;t.spawn(async()=>{for(;;){let a=await s.next();if(!a)break;let{frame:c,group:o}=a;if(!c){r&&(r.final=!0);continue}let l=u.fromMicro(c.timestamp);this.source.sync.received(l,"video");let d=new EncodedVideoChunk({type:c.keyframe?"key":"delta",data:c.data,timestamp:c.timestamp});this.stats.update(m=>({frameCount:(m?.frameCount??0)+1,bytesReceived:(m?.bytesReceived??0)+c.data.byteLength}));let h=r;if(h&&(h.group===o||h.final&&h.group+1===o)){let m=u.fromMicro(h.timestamp),p=u.fromMicro(c.timestamp);this.#s(m,p)}r={timestamp:c.timestamp,group:o,final:!1},n.decode(d)}})}#n(t,e,n){if(this.config.container.kind!=="cmaf")return;let i=$(this.config.container.init),s=G(i),r=this.config.description?D(this.config.description):s.description,a=new Y(e,{format:new le(s),latency:this.source.sync.buffer});t.cleanup(()=>a.close()),t.run(o=>{let l=o.get(a.buffered),d=o.get(this.#t);this.buffered.update(()=>at(l,d))}),n.configure({codec:this.config.codec,description:r,optimizeForLatency:this.config.optimizeForLatency??!0,flip:!1});let c;t.spawn(async()=>{for(;;){let o=await a.next();if(!o)break;let{frame:l,group:d}=o;if(!l){c&&(c.final=!0);continue}let h=u.fromMicro(l.timestamp);this.source.sync.received(h,"video"),this.stats.update(p=>({frameCount:(p?.frameCount??0)+1,bytesReceived:(p?.bytesReceived??0)+l.data.byteLength}));let m=c;if(m&&(m.group===d||m.final&&m.group+1===d)){let p=u.fromMicro(m.timestamp),y=u.fromMicro(l.timestamp);this.#s(p,y)}if(c={timestamp:l.timestamp,group:d,final:!1},n.state==="closed")break;n.decode(new EncodedVideoChunk({type:l.keyframe?"key":"delta",data:l.data,timestamp:l.timestamp}))}})}#s(t,e){t>e||this.#t.mutate(n=>{for(let i of n)if(i.start<=e&&i.end>=t){i.start=u.min(i.start,t),i.end=u.max(i.end,e);return}n.push({start:t,end:e}),n.sort((i,s)=>i.start-s.start)})}#r(t){this.#t.mutate(e=>{for(;e.length>0;){if(e[0].end>=t){e[0].start=u.max(e[0].start,t);break}e.shift()}})}close(){this.signals.close(),this.frame.update(t=>{t?.close()})}};async function hi(t){let e;if(t.description)e=D(t.description);else if(t.container.kind==="cmaf")try{e=G($(t.container.init)).description}catch(i){return console.warn(`video: malformed CMAF init segment for codec ${t.codec}`,i),!1}let{supported:n}=await VideoDecoder.isConfigSupported({codec:t.codec,description:e,optimizeForLatency:t.optimizeForLatency??!0});if(n)return!0;if(t.codec.startsWith("avc3.")){let i=`avc1.${t.codec.slice(5)}`;if((await VideoDecoder.isConfigSupported({codec:i,description:e,optimizeForLatency:t.optimizeForLatency??!0})).supported)return t.codec=i,!0}return!1}var mi=class{muxer;source;#t=new f(void 0);stats=this.#t;#e=new f([]);buffered=this.#e;#i=new f(!1);stalled=this.#i;#n=new f(u.zero);timestamp=this.#n;signals=new x;constructor(t,e){this.muxer=t,this.source=e,this.source.supported.set(pi),this.signals.run(this.#s.bind(this)),this.signals.run(this.#c.bind(this)),this.signals.run(this.#l.bind(this))}#s(t){let e=t.get(this.muxer.element);if(!e)return;let n=t.get(this.muxer.mediaSource);if(!n)return;let i=t.get(this.source.broadcast);if(!i)return;let s=t.get(i.active);if(!s)return;let r=t.get(this.source.track);if(!r)return;let a=t.get(this.source.config);if(!a)return;let c=`video/mp4; codecs="${a.codec}"`,o=n.addSourceBuffer(c);t.cleanup(()=>{n.removeSourceBuffer(o),o.abort()}),t.event(o,"error",l=>{console.error("[MSE] SourceBuffer error:",l)}),t.event(o,"updateend",()=>{this.#e.set(he(o.buffered))}),a.container.kind==="cmaf"?this.#a(t,s,r,a,o,e):this.#o(t,s,r,a,o,e)}async#r(t,e){for(;t.updating;)await new Promise(n=>t.addEventListener("updateend",n,{once:!0}));for(t.appendBuffer(e);t.updating;)await new Promise(n=>t.addEventListener("updateend",n,{once:!0}))}#a(t,e,n,i,s,r){if(i.container.kind!=="cmaf")throw Error("unreachable");let a=e.subscribe(n,X.video);t.cleanup(()=>a.close());let c=$(i.container.init),o=G(c);t.spawn(async()=>{for(await this.#r(s,c);;){let l=await a.readFrame();if(!l)return;let d=se(l,o);this.source.sync.received(u.fromMicro(d),"video"),await this.#r(s,l),r.buffered.length>0&&r.currentTime<r.buffered.start(0)&&(r.currentTime=r.buffered.start(0))}})}#o(t,e,n,i,s,r){let a=e.subscribe(n,X.video);t.cleanup(()=>a.close());let c=i.container.kind==="loc"?new lt:new dt,o=new Y(a,{format:c,latency:this.source.sync.buffer});t.cleanup(()=>o.close()),t.spawn(async()=>{let l=Rn(i);await this.#r(s,l);let d=1,h,m;for(;;){let p=await o.next();if(!p)return;if(!p.frame)continue;m=p.frame;let y=u.fromMicro(m.timestamp);this.source.sync.received(y,"video");break}for(;;){let p=await o.next();if(p&&!p.frame)continue;let y=p?.frame;if(y){h=ct.sub(y.timestamp,m.timestamp);let b=u.fromMicro(y.timestamp);this.source.sync.received(b,"video")}let w=ce({data:m.data,timestamp:m.timestamp,duration:h??0,keyframe:m.keyframe,sequence:d++});if(await this.#r(s,w),r.buffered.length>0&&r.currentTime<r.buffered.start(0)&&(r.currentTime=r.buffered.start(0)),!y)return;m=y}})}#c(t){let e=t.get(this.muxer.element);if(!e)return;let n=()=>{this.#i.set(e.readyState<=HTMLMediaElement.HAVE_CURRENT_DATA)};n(),t.event(e,"waiting",n),t.event(e,"playing",n),t.event(e,"seeking",n)}#l(t){let e=t.get(this.muxer.element);if(e)if("requestVideoFrameCallback"in e){let n=e,i,s=()=>{let r=u.fromSecond(n.currentTime);this.#n.set(r),i=n.requestVideoFrameCallback(s)};i=n.requestVideoFrameCallback(s),t.cleanup(()=>n.cancelVideoFrameCallback(i))}else t.event(e,"timeupdate",()=>{let n=u.fromSecond(e.currentTime);this.#n.set(n)})}close(){this.source.close(),this.signals.close()}};async function pi(t){return MediaSource.isTypeSupported(`video/mp4; codecs="${t.codec}"`)}var jt=.01,gi=class{decoder;canvas;paused;visible;frame=new f(void 0);timestamp=new f(void 0);#t=new f(void 0);#e=new f(!1);#i=new x;constructor(t,e){this.decoder=t,this.canvas=f.from(e?.canvas),this.paused=f.from(e?.paused??!1),this.visible=f.from(e?.visible??"0px"),this.#i.run(n=>{let i=n.get(this.canvas);this.#t.set(i?.getContext("2d")??void 0)}),this.#i.run(this.#s.bind(this)),this.#i.run(this.#r.bind(this)),this.#i.run(this.#a.bind(this)),this.#i.run(this.#n.bind(this))}#n(t){let e=t.getAll([this.canvas,this.decoder.display]);if(!e)return;let[n,i]=e;(n.width!==i.width||n.height!==i.height)&&(n.width=i.width,n.height=i.height)}#s(t){let e=t.get(this.visible);if(e==="never"){this.#e.set(!1);return}if(e==="always"){this.#e.set(!0),t.cleanup(()=>this.#e.set(!1));return}let n=t.get(this.canvas);if(!n){this.#e.set(!1);return}let i=!1,s=()=>{this.#e.set(i&&!document.hidden)},r=c=>{for(let o of c)i=o.isIntersecting,s()},a;try{a=new IntersectionObserver(r,{threshold:jt,rootMargin:e})}catch{console.warn(`moq-watch: invalid visible margin "${e}", using "0px"`),a=new IntersectionObserver(r,{threshold:jt})}s(),t.event(document,"visibilitychange",s),a.observe(n),t.cleanup(()=>a.disconnect()),t.cleanup(()=>this.#e.set(!1))}#r(t){let e=t.get(this.paused),n=t.get(this.#e);if(t.cleanup(()=>this.decoder.enabled.set(!1)),!e){this.decoder.enabled.set(n);return}let i=t.get(this.decoder.frame);this.decoder.enabled.set(!i)}#a(t){let e=t.get(this.#t);if(!e)return;let n=t.get(this.decoder.frame),i=requestAnimationFrame(()=>{this.#o(e,n),n?(this.frame.update(s=>(s?.close(),n.clone())),this.timestamp.set(u.fromMicro(n.timestamp))):(this.frame.update(s=>{s?.close()}),this.timestamp.set(void 0)),i=void 0});t.cleanup(()=>{i&&cancelAnimationFrame(i)})}#o(t,e){if(!e){t.fillStyle="#000",t.fillRect(0,0,t.canvas.width,t.canvas.height);return}t.save(),t.fillStyle="#000",t.fillRect(0,0,t.canvas.width,t.canvas.height),this.decoder.source.catalog.peek()?.flip&&(t.scale(-1,1),t.translate(-t.canvas.width,0)),t.drawImage(e,0,0,t.canvas.width,t.canvas.height),t.restore()}close(){this.frame.update(t=>{t?.close()}),this.timestamp.set(void 0),this.#i.close()}};function wi(t){return e=>{let n=[],i=[];for(let[s,r]of e)if(r.codedWidth&&r.codedHeight){let a=r.codedWidth*r.codedHeight;a<=t?n.push({name:s,size:a}):i.push({name:s,size:a})}return n.sort((s,r)=>r.size-s.size),n.length>0?n.map(s=>s.name):i.length>0?(i.sort((s,r)=>s.size-r.size),[i[0].name]):e.map(([s])=>s)}}function yi(t,e){return n=>{let i=[],s=[];for(let[r,a]of n){if(!a.codedWidth||!a.codedHeight)continue;let c=a.codedWidth*a.codedHeight,o=t==null||a.codedWidth<=t,l=e==null||a.codedHeight<=e;o&&l?i.push({name:r,size:c}):s.push({name:r,size:c})}return i.sort((r,a)=>a.size-r.size),i.length>0?i.map(r=>r.name):s.length>0?(s.sort((r,a)=>r.size-a.size),[s[0].name]):n.map(([r])=>r)}}function bi(t){return e=>{let n=[],i=[];for(let[s,r]of e)r.bitrate!=null&&r.bitrate<=t?n.push({name:s,bitrate:r.bitrate}):r.bitrate!=null&&i.push({name:s,bitrate:r.bitrate});return n.sort((s,r)=>r.bitrate-s.bitrate),n.length>0?n.map(s=>s.name):i.length>0?(i.sort((s,r)=>s.bitrate-r.bitrate),[i[0].name]):e.map(([s])=>s)}}function vi(t){let e=t[0];for(let n of t){let[,i]=n,[,s]=e,r=(i.codedWidth??0)*(i.codedHeight??0),a=(s.codedWidth??0)*(s.codedHeight??0);if(r!==a){r>a&&(e=n);continue}(i.bitrate??0)>(s.bitrate??0)&&(e=n)}return e[0]}var Si=class{broadcast;target;catalog;#t=new f({});available=this.#t;#e=new f(void 0);track=this.#e;#i=new f(void 0);config=this.#i;sync;supported;#n=new x;constructor(t,e){this.broadcast=f.from(e?.broadcast),this.target=f.from(e?.target),this.sync=t,this.supported=f.from(e?.supported),this.catalog=this.#n.computed(n=>{let i=n.get(this.broadcast);return i?n.get(i.catalog)?.video:void 0}),this.#n.run(this.#s.bind(this)),this.#n.run(this.#r.bind(this))}#s(t){let e=t.get(this.supported);if(!e)return;let n=t.get(this.catalog)?.renditions??{};t.spawn(async()=>{let i={};for(let[s,r]of Object.entries(n))await e(r)&&(i[s]=r);Object.keys(i).length===0&&Object.keys(n).length>0&&console.warn("[Source] No supported video renditions found:",n),this.#t.set(i)})}#r(t){let e=t.get(this.#t);if(Object.keys(e).length===0)return;let n=t.get(this.target);if(n?.name&&n.name in e){let c=e[n.name];t.set(this.#e,n.name),t.set(this.#i,c),t.set(this.sync.video,c.jitter);return}let i=n;if(!n?.bitrate){let c=t.get(this.broadcast),o=(c?t.get(c.connection):void 0)?.recvBandwidth;if(o){let l=t.get(o);if(l!=null){let d=Math.round(l*.8);i={...n,bitrate:d}}}}let s=this.#a(e,i);if(!s)return;let r=e[s];t.set(this.#e,s),t.set(this.#i,r);let a=r.jitter??(r.framerate?Math.ceil(1e3/r.framerate):void 0);t.set(this.sync.video,a)}#a(t,e){let n=Object.entries(t);if(n.length===0)return;if(n.length===1)return n[0][0];let i=[];if(e?.pixels!=null&&i.push(wi(e.pixels)),(e?.width!=null||e?.height!=null)&&i.push(yi(e.width,e.height)),e?.bitrate!=null&&i.push(bi(e.bitrate)),i.length===0)return vi(n);let s=i.map(a=>a(n)),r=s.map(a=>new Set(a));for(let a of s[0])if(r.every(c=>c.has(a)))return a;console.warn("conflicting rendition filters, no rendition satisfies all criteria")}close(){this.#n.close()}};function he(t){let e=[];for(let n=0;n<t.length;n++){let i=u.fromSecond(t.start(n)),s=u.fromSecond(t.end(n));e.push({start:i,end:s})}return e}var Ai=class{source;stats=new f(void 0);stalled=new f(!1);buffered=new f([]);timestamp=new f(u.zero);constructor(t){this.source=t}},xi=class{source;volume=new f(.5);muted=new f(!1);stats=new f(void 0);buffered=new f([]);context=new f(void 0);constructor(t){this.source=t}},ki=class{element=new f(void 0);broadcast;latency;jitter;paused;visible;video;#t;audio;#e;sync;signals=new x;constructor(t){this.element=f.from(t?.element),this.broadcast=f.from(t?.broadcast),this.sync=new ci({latency:t?.latency,connection:t?.connection}),this.latency=this.sync.latency,this.jitter=this.sync.jitter,this.#t=new Si(this.sync,{broadcast:this.broadcast}),this.#e=new Ei(this.sync,{broadcast:this.broadcast}),this.video=new Ai(this.#t),this.audio=new xi(this.#e),this.paused=f.from(t?.paused??!1),this.visible=f.from(t?.visible??"0px"),this.signals.run(this.#i.bind(this))}#i(t){let e=t.get(this.element);e&&(e instanceof HTMLCanvasElement?this.#n(t,e):e instanceof HTMLVideoElement&&this.#s(t,e))}#n(t,e){let n=new fi(this.#t),i=new ii(this.#e),s=new ri(i,{volume:this.audio.volume,muted:this.audio.muted,paused:this.paused}),r=new gi(n,{canvas:e,paused:this.paused,visible:this.visible});t.cleanup(()=>{n.close(),i.close(),s.close(),r.close()}),t.proxy(this.video.stats,n.stats),t.proxy(this.video.buffered,n.buffered),t.proxy(this.video.stalled,n.stalled),t.proxy(this.video.timestamp,n.timestamp),t.proxy(this.audio.stats,i.stats),t.proxy(this.audio.buffered,i.buffered),t.proxy(this.audio.context,i.context)}#s(t,e){let n=new ai(this.sync,{paused:this.paused,element:e}),i=new mi(n,this.#t),s=new Ui(n,this.#e,{volume:this.audio.volume,muted:this.audio.muted});t.cleanup(()=>{i.close(),s.close(),n.close()}),t.proxy(this.video.stats,i.stats),t.proxy(this.video.buffered,i.buffered),t.proxy(this.video.stalled,i.stalled),t.proxy(this.video.timestamp,i.timestamp),t.proxy(this.audio.stats,s.stats),t.proxy(this.audio.buffered,s.buffered),t.proxy(this.audio.context,s.context)}close(){this.signals.close(),this.#t.close(),this.#e.close(),this.sync.close()}},Ui=class{muxer;source;volume;muted;#t=new f(void 0);stats=this.#t;#e=new f([]);buffered=this.#e;context=new f(void 0);#i=new x;constructor(t,e,n){this.muxer=t,this.source=e,this.source.supported.set(Ti),this.volume=f.from(n?.volume??.5),this.muted=f.from(n?.muted??!1),this.#i.run(this.#n.bind(this)),this.#i.run(this.#o.bind(this))}#n(t){let e=t.get(this.muxer.element);if(!e)return;let n=t.get(this.muxer.mediaSource);if(!n)return;let i=t.get(this.source.broadcast);if(!i)return;let s=t.get(i.active);if(!s)return;let r=t.get(this.source.track);if(!r)return;let a=t.get(this.source.config);if(!a)return;let c=`audio/mp4; codecs="${a.codec}"`,o=n.addSourceBuffer(c);t.cleanup(()=>{n.removeSourceBuffer(o),o.abort()}),t.event(o,"error",d=>{console.error("[MSE] SourceBuffer error:",d)}),t.event(o,"updateend",()=>{this.#e.set(he(o.buffered))});let l=s.subscribe(r,X.audio);t.cleanup(()=>l.close()),a.container.kind==="cmaf"?this.#r(t,l,a,o,e):this.#a(t,l,a,o,e)}async#s(t,e){for(;t.updating;)await new Promise(n=>t.addEventListener("updateend",n,{once:!0}));for(t.appendBuffer(e);t.updating;)await new Promise(n=>t.addEventListener("updateend",n,{once:!0}))}#r(t,e,n,i,s){if(n.container.kind!=="cmaf")throw Error("unreachable");let r=$(n.container.init),a=G(r);t.spawn(async()=>{for(await this.#s(i,r);;){let c=await e.readFrame();if(!c)return;let o=se(c,a);this.source.sync.received(u.fromMicro(o),"audio"),await this.#s(i,c),s.buffered.length>0&&s.currentTime<s.buffered.start(0)&&(s.currentTime=s.buffered.start(0))}})}#a(t,e,n,i,s){let r=n.container.kind==="loc"?new lt:new dt,a=new Y(e,{format:r,latency:this.source.sync.buffer});t.cleanup(()=>a.close()),t.spawn(async()=>{let c=_n(n);await this.#s(i,c);let o=1,l,d;for(;;){let h=await a.next();if(!h)return;if(!h.frame)continue;d=h.frame;let m=u.fromMicro(d.timestamp);this.source.sync.received(m,"audio");break}for(;;){let h=await a.next();if(h&&!h.frame)continue;let m=h?.frame;if(m){l=ct.sub(m.timestamp,d.timestamp);let y=u.fromMicro(m.timestamp);this.source.sync.received(y,"audio")}let p=ce({data:d.data,timestamp:d.timestamp,duration:l??0,keyframe:d.keyframe,sequence:o++});if(await this.#s(i,p),s.buffered.length>0&&s.currentTime<s.buffered.start(0)&&(s.currentTime=s.buffered.start(0)),!m)return;d=m}})}#o(t){let e=t.get(this.muxer.element);if(!e)return;let n=t.get(this.volume),i=t.get(this.muted);i&&!e.muted?e.muted=!0:!i&&e.muted&&(e.muted=!1),n!==e.volume&&(e.volume=n),t.event(e,"volumechange",()=>{this.volume.set(e.volume)})}close(){this.#i.close()}};async function Ti(t){return MediaSource.isTypeSupported(`audio/mp4; codecs="${t.codec}"`)}var Mi=128,Ei=class{broadcast;target;catalog;#t=new f({});available=this.#t;#e=new f(void 0);track=this.#e;#i=new f(void 0);config=this.#i;supported;sync;#n=new x;constructor(t,e){this.sync=t,this.broadcast=f.from(e?.broadcast),this.target=f.from(e?.target),this.supported=f.from(e?.supported),this.catalog=this.#n.computed(n=>{let i=n.get(this.broadcast);return i?n.get(i.catalog)?.audio:void 0}),this.#n.run(this.#s.bind(this)),this.#n.run(this.#r.bind(this))}#s(t){let e=t.get(this.catalog)?.renditions??{},n=t.get(this.supported);n&&t.spawn(async()=>{let i={};for(let[s,r]of Object.entries(e))await n(r)&&(i[s]=r);Object.keys(i).length===0&&Object.keys(e).length>0&&console.warn("no supported audio renditions found:",e),this.#t.set(i)})}#r(t){let e=t.get(this.#t);if(Object.keys(e).length===0)return;let n=t.get(this.target),i;if(n?.name&&n.name in e)i={track:n.name,config:e[n.name]};else if(i=this.#a(e),!i)return;t.set(this.#e,i.track),t.set(this.#i,i.config);let s=(i.config.jitter??zi(i.config)??0)+Math.ceil(Mi/i.config.sampleRate*1e3);t.set(this.sync.audio,s)}#a(t){let e=Object.entries(t);if(e.length!==0){for(let[n,i]of e)if(i.container.kind==="legacy")return{track:n,config:i};for(let[n,i]of e)if(i.container.kind==="loc")return{track:n,config:i};for(let[n,i]of e)if(i.container.kind==="cmaf")return{track:n,config:i}}}close(){this.#n.close()}};function zi(t){if(t.codec.startsWith("opus"))return 20;if(t.codec.startsWith("mp4a"))return Math.ceil(1024/t.sampleRate*1e3)}var Bi=48e3,Pt=2;function Ci(t){let e="";for(let n=0;n<t.length;n++)e+=t[n].toString(16).padStart(2,"0");return e}function me(t){let e;try{e=t.initData?$(t.initData):void 0}catch{e=void 0}return t.packaging==="cmaf"&&t.initData&&e?{container:{kind:"cmaf",init:t.initData},description:void 0}:{container:{kind:"legacy"},description:e?Ci(e):void 0}}function Ii(t){if(!t.codec)return;let{container:e,description:n}=me(t);return{codec:t.codec,container:e,description:n,codedWidth:t.width==null?void 0:O(t.width),codedHeight:t.height==null?void 0:O(t.height),framerate:t.framerate,bitrate:t.bitrate==null?void 0:O(t.bitrate),jitter:t.jitter==null?void 0:O(t.jitter)}}function Di(t){if(!t.codec)return;let e=(()=>{if(!t.channelConfig)return Pt;let s=Number.parseInt(t.channelConfig,10);return Number.isFinite(s)?s:Pt})(),{container:n,description:i}=me(t);return{codec:t.codec,container:n,description:i,sampleRate:O(t.samplerate??Bi),numberOfChannels:O(e),bitrate:t.bitrate==null?void 0:O(t.bitrate),jitter:t.jitter==null?void 0:O(t.jitter)}}function Li(t){let e={},n={};for(let s of t.tracks)if(s.role==="video"){let r=Ii(s);r&&(e[s.name]=r)}else if(s.role==="audio"){let r=Di(s);r&&(n[s.name]=r)}let i={};return Object.keys(e).length>0&&(i.video={renditions:e}),Object.keys(n).length>0&&(i.audio={renditions:n}),i}var Ri=[...ne,"manual"];function _i(t){if(t!==null)return Ri.find(e=>e===t)}var Fi=class{connection;enabled;name;status=new f("offline");reload;catalogFormat;#t=new f(void 0);active=this.#t;catalog;#e;#i=new f(!1);signals=new x;constructor(t){this.connection=f.from(t?.connection),this.name=f.from(t?.name??ke()),this.enabled=f.from(t?.enabled??!1),this.reload=f.from(t?.reload??!1),this.catalogFormat=f.from(t?.catalogFormat),this.catalog=f.from(t?.catalog),this.#e=t?.announced??new f(new Set),this.signals.run(this.#n.bind(this)),this.signals.run(this.#s.bind(this)),this.signals.run(this.#r.bind(this))}#n(t){if(!t.get(this.reload)){this.#i.set(!0);return}if(t.get(this.connection)?.url.hostname.endsWith("mediaoverquic.com")){console.warn("Cloudflare relay does not support broadcast discovery yet; ignoring reload signal."),this.#i.set(!0);return}let e=t.get(this.name),n=t.get(this.#e);this.#i.set(n.has(e))}#s(t){if(!t.get(this.enabled)||!t.get(this.#i))return;let e=t.get(this.connection);if(!e)return;let n=t.get(this.name),i=e.consume(n);t.cleanup(()=>i.close()),t.set(this.#t,i,void 0)}#r(t){if(!t.get(this.enabled))return;let e=t.get(this.catalogFormat),n=t.get(this.name),i=e??Tn(n)??Un;if(i==="manual"){let o=t.get(this.catalog);this.status.set(o?"live":"loading");return}let s=t.get(this.active);if(!s)return;this.status.set("loading");let r=i==="hang"?"catalog.json":"catalog",a=s.subscribe(r,X.catalog);t.cleanup(()=>a.close());let c;if(i==="hang"){let o=new Te(a,{schema:kn});c=()=>o.next()}else c=async()=>{let o=await Xn(a);return o?Li(o):void 0};t.spawn(async()=>{try{for(;;){let o=await Promise.race([t.cancel,c()]);if(!o)break;console.debug("received catalog",i,this.name.peek(),o),this.catalog.set(o),this.status.set("live")}}catch(o){console.warn("error fetching catalog",this.name.peek(),o)}finally{this.catalog.set(void 0),this.status.set("offline")}})}subscribeTrack(t,e,n){let i=new x;return i.run(s=>{let r=s.get(this.active);if(!r)return;let a=r.subscribe(t,e);s.cleanup(()=>a.close()),n(a,s)}),this.signals.cleanup(()=>i.close()),()=>i.close()}close(){this.signals.close()}},Oi=["url","name","paused","volume","muted","visible","reload","latency","jitter","catalog-format"];function Ni(t){let e=t?.trim();return e?e==="never"||e==="always"||/^-?\d+(\.\d+)?(px|%)$/.test(e)?e:/^-?\d+(\.\d+)?$/.test(e)?`${e}px`:(console.warn(`moq-watch: invalid visible="${t}", expected "never", "always", or a CSS length like "200px"`),"0px"):"0px"}var ji=new FinalizationRegistry(t=>t.close()),Pi=class extends HTMLElement{static observedAttributes=Oi;connection;broadcast;backend;#t=new f(!1);signals=new x;constructor(){super(),ji.register(this,this.signals),this.connection=new Ue({enabled:this.#t}),this.signals.cleanup(()=>this.connection.close()),this.broadcast=new Fi({connection:this.connection.established,announced:this.connection.announced,enabled:this.#t}),this.signals.cleanup(()=>this.broadcast.close()),this.backend=new ki({broadcast:this.broadcast,connection:this.connection.established}),this.signals.cleanup(()=>this.backend.close());let t=()=>{let r=this.querySelector("canvas"),a=this.querySelector("video");if(r&&a)throw Error("Cannot have both canvas and video elements");this.backend.element.set(r??a)},e=new MutationObserver(t);e.observe(this,{childList:!0,subtree:!0}),this.signals.cleanup(()=>e.disconnect()),t(),this.signals.run(r=>{let a=r.get(this.connection.url);a?this.setAttribute("url",a.toString()):this.removeAttribute("url")}),this.signals.run(r=>{let a=r.get(this.broadcast.name);this.setAttribute("name",a.toString())}),this.signals.run(r=>{r.get(this.backend.audio.muted)?this.setAttribute("muted",""):this.removeAttribute("muted")}),this.signals.run(r=>{r.get(this.backend.paused)?this.setAttribute("paused","true"):this.removeAttribute("paused")}),this.signals.run(r=>{let a=r.get(this.backend.visible);this.setAttribute("visible",a)}),this.signals.run(r=>{let a=r.get(this.backend.audio.volume);this.setAttribute("volume",a.toString())}),this.signals.run(r=>{if(r.get(this.backend.latency)==="real-time")this.setAttribute("latency","real-time");else{let a=Math.floor(r.get(this.backend.jitter));this.setAttribute("latency",a.toString())}});let n=(r,a)=>{if(r<=0||a<=0)return;let c=window.devicePixelRatio||1;this.backend.video.source.target.update(o=>({...o,width:Math.round(r*c),height:Math.round(a*c)}))},i=new ResizeObserver(r=>{let a=r[0];a&&n(a.contentRect.width,a.contentRect.height)});i.observe(this),this.signals.cleanup(()=>i.disconnect());let s=this.getBoundingClientRect();n(s.width,s.height)}connectedCallback(){this.#t.set(!0),this.style.display="block",this.style.position="relative"}disconnectedCallback(){this.#t.set(!1)}#e(t){let e=t?Number.parseFloat(t):NaN;this.backend.latency.set(Number.isFinite(e)?e:100)}attributeChangedCallback(t,e,n){if(e!==n)if(t==="url")this.connection.url.set(n?new URL(n):void 0);else if(t==="name")this.broadcast.name.set(xt(n??""));else if(t==="paused")this.backend.paused.set(n!==null);else if(t==="volume"){let i=n?Number.parseFloat(n):.5;this.backend.audio.volume.set(i)}else if(t==="muted")this.backend.audio.muted.set(n!==null);else if(t==="visible")this.backend.visible.set(Ni(n));else if(t==="reload")this.broadcast.reload.set(n!==null);else if(t==="latency")!n||n==="real-time"?this.backend.latency.set("real-time"):this.#e(n);else if(t==="jitter")this.#e(n);else if(t==="catalog-format")this.broadcast.catalogFormat.set(_i(n));else throw Error(`Invalid attribute: ${t}`)}get url(){return this.connection.url.peek()}set url(t){this.connection.url.set(t?new URL(t):void 0)}get name(){return this.broadcast.name.peek()}set name(t){this.broadcast.name.set(xt(t))}get paused(){return this.backend.paused.peek()}set paused(t){this.backend.paused.set(t)}get volume(){return this.backend.audio.volume.peek()}set volume(t){this.backend.audio.volume.set(t)}get muted(){return this.backend.audio.muted.peek()}set muted(t){this.backend.audio.muted.set(t)}get visible(){return this.backend.visible.peek()}set visible(t){this.backend.visible.set(t)}get reload(){return this.broadcast.reload.peek()}set reload(t){this.broadcast.reload.set(t)}get latency(){return this.backend.latency.peek()}set latency(t){this.backend.latency.set(t)}get jitter(){return this.backend.jitter.peek()}set jitter(t){this.backend.latency.set(t)}get catalogFormat(){return this.broadcast.catalogFormat.peek()}set catalogFormat(t){this.broadcast.catalogFormat.set(t)}get catalog(){return this.broadcast.catalog.peek()}set catalog(t){this.broadcast.catalog.set(t)}};customElements.define("moq-watch",Pi);export{Pi as default};
