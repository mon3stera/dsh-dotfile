/**
 * Browser half of dsh-plugin-background. Hand-written client bundle in the
 * DSH client-modules format (window.__ModuleLoader__.load CJS factory), the
 * same shape tsdown emits for every @deepseek-ai/dsh-client-ui-* plugin.
 *
 * Features:
 *  - a fixed wallpaper layer behind the app frame (body::before, driven by
 *    --dsh-wallpaper-image / --dsh-wallpaper-opacity custom properties),
 *  - preset gradients plus a custom image URL, persisted through the Host
 *    settings document (namespace `ui-background`),
 *  - a "背景 / Background" settings row in Settings > General with swatches
 *    and an opacity slider (slot `settings.general.item`, order 20),
 *  - theme-aware scrim so text stays readable in light and dark palettes.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-background",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const jsx = require("react/jsx-runtime").jsx;
		const { defineStore } = require("@deepseek-ai/dsh-client-runtime/client");
		//#region vendored @material/material-color-utilities 0.4.0 (rebuild: dsh-plugin-build/vendor-mcu.mjs)
		/*__MCU_START__*/
var MCU=(()=>{var Wt=Object.defineProperty;var Fe=Object.getOwnPropertyDescriptor;var we=Object.getOwnPropertyNames;var ve=Object.prototype.hasOwnProperty;var Ee=(r,t)=>{for(var e in t)Wt(r,e,{get:t[e],enumerable:!0})},Ie=(r,t,e,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let a of we(t))!ve.call(r,a)&&a!==e&&Wt(r,a,{get:()=>t[a],enumerable:!(n=Fe(t,a))||n.enumerable});return r};var Me=r=>Ie(Wt({},"__esModule",{value:!0}),r);var Ke={};Ee(Ke,{Hct:()=>T,QuantizerCelebi:()=>At,SchemeContent:()=>Vt,SchemeExpressive:()=>Nt,SchemeFidelity:()=>Ht,SchemeFruitSalad:()=>Ut,SchemeMonochrome:()=>_t,SchemeNeutral:()=>zt,SchemeRainbow:()=>Gt,SchemeTonalSpot:()=>Yt,SchemeVibrant:()=>Kt,Score:()=>Q,argbFromHex:()=>Ae,argbFromRgb:()=>ht,hexFromArgb:()=>ue});function G(r){return r<0?-1:r===0?0:1}function st(r,t,e){return(1-e)*r+e*t}function fe(r,t,e){return e<r?r:e>t?t:e}function U(r,t,e){return e<r?r:e>t?t:e}function lt(r){return r=r%360,r<0&&(r=r+360),r}function z(r){return r=r%360,r<0&&(r=r+360),r}function Jt(r,t){return 180-Math.abs(Math.abs(r-t)-180)}function yt(r,t){let e=r[0]*t[0][0]+r[1]*t[0][1]+r[2]*t[0][2],n=r[0]*t[1][0]+r[1]*t[1][1]+r[2]*t[1][2],a=r[0]*t[2][0]+r[1]*t[2][1]+r[2]*t[2][2];return[e,n,a]}var pe=[[.41233895,.35762064,.18051042],[.2126,.7152,.0722],[.01932141,.11916382,.95034478]],Be=[[3.2413774792388685,-1.5376652402851851,-.49885366846268053],[-.9691452513005321,1.8758853451067872,.04156585616912061],[.05562093689691305,-.20395524564742123,1.0571799111220335]],Zt=[95.047,100,108.883];function ht(r,t,e){return(255<<24|(r&255)<<16|(t&255)<<8|e&255)>>>0}function Qt(r){let t=ct(r[0]),e=ct(r[1]),n=ct(r[2]);return ht(t,e,n)}function de(r){return r>>24&255}function mt(r){return r>>16&255}function ft(r){return r>>8&255}function pt(r){return r&255}function te(r,t,e){let n=Be,a=n[0][0]*r+n[0][1]*t+n[0][2]*e,o=n[1][0]*r+n[1][1]*t+n[1][2]*e,i=n[2][0]*r+n[2][1]*t+n[2][2]*e,c=ct(a),f=ct(o),g=ct(i);return ht(c,f,g)}function Re(r){let t=et(mt(r)),e=et(ft(r)),n=et(pt(r));return yt([t,e,n],pe)}function ge(r,t,e){let n=Zt,a=(r+16)/116,o=t/500+a,i=a-e/200,c=bt(o),f=bt(a),g=bt(i),m=c*n[0],y=f*n[1],P=g*n[2];return te(m,y,P)}function Ft(r){let t=et(mt(r)),e=et(ft(r)),n=et(pt(r)),a=pe,o=a[0][0]*t+a[0][1]*e+a[0][2]*n,i=a[1][0]*t+a[1][1]*e+a[1][2]*n,c=a[2][0]*t+a[2][1]*e+a[2][2]*n,f=Zt,g=o/f[0],m=i/f[1],y=c/f[2],P=Pt(g),d=Pt(m),p=Pt(y),l=116*d-16,C=500*(P-d),v=200*(d-p);return[l,C,v]}function ye(r){let t=j(r),e=ct(t);return ht(e,e,e)}function wt(r){let t=Re(r)[1];return 116*Pt(t/100)-16}function j(r){return 100*bt((r+16)/116)}function Ct(r){return Pt(r/100)*116-16}function et(r){let t=r/255;return t<=.040449936?t/12.92*100:Math.pow((t+.055)/1.055,2.4)*100}function ct(r){let t=r/100,e=0;return t<=.0031308?e=t*12.92:e=1.055*Math.pow(t,1/2.4)-.055,fe(0,255,Math.round(e*255))}function Pe(){return Zt}function Pt(r){let t=.008856451679035631,e=24389/27;return r>t?Math.pow(r,1/3):(e*r+16)/116}function bt(r){let t=.008856451679035631,e=24389/27,n=r*r*r;return n>t?n:(116*r-16)/e}var X=class r{static make(t=Pe(),e=200/Math.PI*j(50)/100,n=50,a=2,o=!1){let i=t,c=i[0]*.401288+i[1]*.650173+i[2]*-.051461,f=i[0]*-.250268+i[1]*1.204414+i[2]*.045854,g=i[0]*-.002079+i[1]*.048952+i[2]*.953127,m=.8+a/10,y=m>=.9?st(.59,.69,(m-.9)*10):st(.525,.59,(m-.8)*10),P=o?1:m*(1-1/3.6*Math.exp((-e-42)/92));P=P>1?1:P<0?0:P;let d=m,p=[P*(100/c)+1-P,P*(100/f)+1-P,P*(100/g)+1-P],l=1/(5*e+1),C=l*l*l*l,v=1-C,S=C*e+.1*v*v*Math.cbrt(5*e),k=j(n)/t[1],I=1.48+Math.sqrt(k),L=.725/Math.pow(k,.2),O=L,A=[Math.pow(S*p[0]*c/100,.42),Math.pow(S*p[1]*f/100,.42),Math.pow(S*p[2]*g/100,.42)],E=[400*A[0]/(A[0]+27.13),400*A[1]/(A[1]+27.13),400*A[2]/(A[2]+27.13)],V=(2*E[0]+E[1]+.05*E[2])*L;return new r(k,V,L,O,y,d,p,S,Math.pow(S,.25),I)}constructor(t,e,n,a,o,i,c,f,g,m){this.n=t,this.aw=e,this.nbb=n,this.ncb=a,this.c=o,this.nc=i,this.rgbD=c,this.fl=f,this.fLRoot=g,this.z=m}};X.DEFAULT=X.make();var rt=class r{constructor(t,e,n,a,o,i,c,f,g){this.hue=t,this.chroma=e,this.j=n,this.q=a,this.m=o,this.s=i,this.jstar=c,this.astar=f,this.bstar=g}distance(t){let e=this.jstar-t.jstar,n=this.astar-t.astar,a=this.bstar-t.bstar,o=Math.sqrt(e*e+n*n+a*a);return 1.41*Math.pow(o,.63)}static fromInt(t){return r.fromIntInViewingConditions(t,X.DEFAULT)}static fromIntInViewingConditions(t,e){let n=(t&16711680)>>16,a=(t&65280)>>8,o=t&255,i=et(n),c=et(a),f=et(o),g=.41233895*i+.35762064*c+.18051042*f,m=.2126*i+.7152*c+.0722*f,y=.01932141*i+.11916382*c+.95034478*f,P=.401288*g+.650173*m-.051461*y,d=-.250268*g+1.204414*m+.045854*y,p=-.002079*g+.048952*m+.953127*y,l=e.rgbD[0]*P,C=e.rgbD[1]*d,v=e.rgbD[2]*p,S=Math.pow(e.fl*Math.abs(l)/100,.42),k=Math.pow(e.fl*Math.abs(C)/100,.42),I=Math.pow(e.fl*Math.abs(v)/100,.42),L=G(l)*400*S/(S+27.13),O=G(C)*400*k/(k+27.13),A=G(v)*400*I/(I+27.13),E=(11*L+-12*O+A)/11,V=(L+O-2*A)/9,R=(20*L+20*O+21*A)/20,Y=(40*L+20*O+A)/20,tt=Math.atan2(V,E)*180/Math.PI,_=z(tt),it=_*Math.PI/180,Tt=Y*e.nbb,at=100*Math.pow(Tt/e.aw,e.c*e.z),Dt=4/e.c*Math.sqrt(at/100)*(e.aw+4)*e.fLRoot,Xt=_<20.14?_+360:_,qt=.25*(Math.cos(Xt*Math.PI/180+2)+3.8),jt=5e4/13*qt*e.nc*e.ncb*Math.sqrt(E*E+V*V)/(R+.305),kt=Math.pow(jt,.9)*Math.pow(1.64-Math.pow(.29,e.n),.73),le=kt*Math.sqrt(at/100),he=le*e.fLRoot,Te=50*Math.sqrt(kt*e.c/(e.aw+4)),De=(1+100*.007)*at/(1+.007*at),me=1/.0228*Math.log(1+.0228*he),ke=me*Math.cos(it),be=me*Math.sin(it);return new r(_,le,at,Dt,he,Te,De,ke,be)}static fromJch(t,e,n){return r.fromJchInViewingConditions(t,e,n,X.DEFAULT)}static fromJchInViewingConditions(t,e,n,a){let o=4/a.c*Math.sqrt(t/100)*(a.aw+4)*a.fLRoot,i=e*a.fLRoot,c=e/Math.sqrt(t/100),f=50*Math.sqrt(c*a.c/(a.aw+4)),g=n*Math.PI/180,m=(1+100*.007)*t/(1+.007*t),y=1/.0228*Math.log(1+.0228*i),P=y*Math.cos(g),d=y*Math.sin(g);return new r(n,e,t,o,i,f,m,P,d)}static fromUcs(t,e,n){return r.fromUcsInViewingConditions(t,e,n,X.DEFAULT)}static fromUcsInViewingConditions(t,e,n,a){let o=e,i=n,c=Math.sqrt(o*o+i*i),g=(Math.exp(c*.0228)-1)/.0228/a.fLRoot,m=Math.atan2(i,o)*(180/Math.PI);m<0&&(m+=360);let y=t/(1-(t-100)*.007);return r.fromJchInViewingConditions(y,g,m,a)}toInt(){return this.viewed(X.DEFAULT)}viewed(t){let e=this.chroma===0||this.j===0?0:this.chroma/Math.sqrt(this.j/100),n=Math.pow(e/Math.pow(1.64-Math.pow(.29,t.n),.73),1/.9),a=this.hue*Math.PI/180,o=.25*(Math.cos(a+2)+3.8),i=t.aw*Math.pow(this.j/100,1/t.c/t.z),c=o*(5e4/13)*t.nc*t.ncb,f=i/t.nbb,g=Math.sin(a),m=Math.cos(a),y=23*(f+.305)*n/(23*c+11*n*m+108*n*g),P=y*m,d=y*g,p=(460*f+451*P+288*d)/1403,l=(460*f-891*P-261*d)/1403,C=(460*f-220*P-6300*d)/1403,v=Math.max(0,27.13*Math.abs(p)/(400-Math.abs(p))),S=G(p)*(100/t.fl)*Math.pow(v,1/.42),k=Math.max(0,27.13*Math.abs(l)/(400-Math.abs(l))),I=G(l)*(100/t.fl)*Math.pow(k,1/.42),L=Math.max(0,27.13*Math.abs(C)/(400-Math.abs(C))),O=G(C)*(100/t.fl)*Math.pow(L,1/.42),A=S/t.rgbD[0],E=I/t.rgbD[1],V=O/t.rgbD[2],R=1.86206786*A-1.01125463*E+.14918677*V,Y=.38752654*A+.62144744*E-.00897398*V,q=-.0158415*A-.03412294*E+1.04996444*V;return te(R,Y,q)}static fromXyzInViewingConditions(t,e,n,a){let o=.401288*t+.650173*e-.051461*n,i=-.250268*t+1.204414*e+.045854*n,c=-.002079*t+.048952*e+.953127*n,f=a.rgbD[0]*o,g=a.rgbD[1]*i,m=a.rgbD[2]*c,y=Math.pow(a.fl*Math.abs(f)/100,.42),P=Math.pow(a.fl*Math.abs(g)/100,.42),d=Math.pow(a.fl*Math.abs(m)/100,.42),p=G(f)*400*y/(y+27.13),l=G(g)*400*P/(P+27.13),C=G(m)*400*d/(d+27.13),v=(11*p+-12*l+C)/11,S=(p+l-2*C)/9,k=(20*p+20*l+21*C)/20,I=(40*p+20*l+C)/20,O=Math.atan2(S,v)*180/Math.PI,A=O<0?O+360:O>=360?O-360:O,E=A*Math.PI/180,V=I*a.nbb,R=100*Math.pow(V/a.aw,a.c*a.z),Y=4/a.c*Math.sqrt(R/100)*(a.aw+4)*a.fLRoot,q=A<20.14?A+360:A,tt=1/4*(Math.cos(q*Math.PI/180+2)+3.8),it=5e4/13*tt*a.nc*a.ncb*Math.sqrt(v*v+S*S)/(k+.305),Tt=Math.pow(it,.9)*Math.pow(1.64-Math.pow(.29,a.n),.73),at=Tt*Math.sqrt(R/100),Dt=at*a.fLRoot,Xt=50*Math.sqrt(Tt*a.c/(a.aw+4)),qt=(1+100*.007)*R/(1+.007*R),$t=Math.log(1+.0228*Dt)/.0228,jt=$t*Math.cos(E),kt=$t*Math.sin(E);return new r(A,at,R,Y,Dt,Xt,qt,jt,kt)}xyzInViewingConditions(t){let e=this.chroma===0||this.j===0?0:this.chroma/Math.sqrt(this.j/100),n=Math.pow(e/Math.pow(1.64-Math.pow(.29,t.n),.73),1/.9),a=this.hue*Math.PI/180,o=.25*(Math.cos(a+2)+3.8),i=t.aw*Math.pow(this.j/100,1/t.c/t.z),c=o*(5e4/13)*t.nc*t.ncb,f=i/t.nbb,g=Math.sin(a),m=Math.cos(a),y=23*(f+.305)*n/(23*c+11*n*m+108*n*g),P=y*m,d=y*g,p=(460*f+451*P+288*d)/1403,l=(460*f-891*P-261*d)/1403,C=(460*f-220*P-6300*d)/1403,v=Math.max(0,27.13*Math.abs(p)/(400-Math.abs(p))),S=G(p)*(100/t.fl)*Math.pow(v,1/.42),k=Math.max(0,27.13*Math.abs(l)/(400-Math.abs(l))),I=G(l)*(100/t.fl)*Math.pow(k,1/.42),L=Math.max(0,27.13*Math.abs(C)/(400-Math.abs(C))),O=G(C)*(100/t.fl)*Math.pow(L,1/.42),A=S/t.rgbD[0],E=I/t.rgbD[1],V=O/t.rgbD[2],R=1.86206786*A-1.01125463*E+.14918677*V,Y=.38752654*A+.62144744*E-.00897398*V,q=-.0158415*A-.03412294*E+1.04996444*V;return[R,Y,q]}};var J=class r{static sanitizeRadians(t){return(t+Math.PI*8)%(Math.PI*2)}static trueDelinearized(t){let e=t/100,n=0;return e<=.0031308?n=e*12.92:n=1.055*Math.pow(e,1/2.4)-.055,n*255}static chromaticAdaptation(t){let e=Math.pow(Math.abs(t),.42);return G(t)*400*e/(e+27.13)}static hueOf(t){let e=yt(t,r.SCALED_DISCOUNT_FROM_LINRGB),n=r.chromaticAdaptation(e[0]),a=r.chromaticAdaptation(e[1]),o=r.chromaticAdaptation(e[2]),i=(11*n+-12*a+o)/11,c=(n+a-2*o)/9;return Math.atan2(c,i)}static areInCyclicOrder(t,e,n){let a=r.sanitizeRadians(e-t),o=r.sanitizeRadians(n-t);return a<o}static intercept(t,e,n){return(e-t)/(n-t)}static lerpPoint(t,e,n){return[t[0]+(n[0]-t[0])*e,t[1]+(n[1]-t[1])*e,t[2]+(n[2]-t[2])*e]}static setCoordinate(t,e,n,a){let o=r.intercept(t[a],e,n[a]);return r.lerpPoint(t,o,n)}static isBounded(t){return 0<=t&&t<=100}static nthVertex(t,e){let n=r.Y_FROM_LINRGB[0],a=r.Y_FROM_LINRGB[1],o=r.Y_FROM_LINRGB[2],i=e%4<=1?0:100,c=e%2===0?0:100;if(e<4){let f=i,g=c,m=(t-f*a-g*o)/n;return r.isBounded(m)?[m,f,g]:[-1,-1,-1]}else if(e<8){let f=i,g=c,m=(t-g*n-f*o)/a;return r.isBounded(m)?[g,m,f]:[-1,-1,-1]}else{let f=i,g=c,m=(t-f*n-g*a)/o;return r.isBounded(m)?[f,g,m]:[-1,-1,-1]}}static bisectToSegment(t,e){let n=[-1,-1,-1],a=n,o=0,i=0,c=!1,f=!0;for(let g=0;g<12;g++){let m=r.nthVertex(t,g);if(m[0]<0)continue;let y=r.hueOf(m);if(!c){n=m,a=m,o=y,i=y,c=!0;continue}(f||r.areInCyclicOrder(o,y,i))&&(f=!1,r.areInCyclicOrder(o,e,y)?(a=m,i=y):(n=m,o=y))}return[n,a]}static midpoint(t,e){return[(t[0]+e[0])/2,(t[1]+e[1])/2,(t[2]+e[2])/2]}static criticalPlaneBelow(t){return Math.floor(t-.5)}static criticalPlaneAbove(t){return Math.ceil(t-.5)}static bisectToLimit(t,e){let n=r.bisectToSegment(t,e),a=n[0],o=r.hueOf(a),i=n[1];for(let c=0;c<3;c++)if(a[c]!==i[c]){let f=-1,g=255;a[c]<i[c]?(f=r.criticalPlaneBelow(r.trueDelinearized(a[c])),g=r.criticalPlaneAbove(r.trueDelinearized(i[c]))):(f=r.criticalPlaneAbove(r.trueDelinearized(a[c])),g=r.criticalPlaneBelow(r.trueDelinearized(i[c])));for(let m=0;m<8&&!(Math.abs(g-f)<=1);m++){let y=Math.floor((f+g)/2),P=r.CRITICAL_PLANES[y],d=r.setCoordinate(a,P,i,c),p=r.hueOf(d);r.areInCyclicOrder(o,e,p)?(i=d,g=y):(a=d,o=p,f=y)}}return r.midpoint(a,i)}static inverseChromaticAdaptation(t){let e=Math.abs(t),n=Math.max(0,27.13*e/(400-e));return G(t)*Math.pow(n,1/.42)}static findResultByJ(t,e,n){let a=Math.sqrt(n)*11,o=X.DEFAULT,i=1/Math.pow(1.64-Math.pow(.29,o.n),.73),f=.25*(Math.cos(t+2)+3.8)*(5e4/13)*o.nc*o.ncb,g=Math.sin(t),m=Math.cos(t);for(let y=0;y<5;y++){let P=a/100,d=e===0||a===0?0:e/Math.sqrt(P),p=Math.pow(d*i,1/.9),C=o.aw*Math.pow(P,1/o.c/o.z)/o.nbb,v=23*(C+.305)*p/(23*f+11*p*m+108*p*g),S=v*m,k=v*g,I=(460*C+451*S+288*k)/1403,L=(460*C-891*S-261*k)/1403,O=(460*C-220*S-6300*k)/1403,A=r.inverseChromaticAdaptation(I),E=r.inverseChromaticAdaptation(L),V=r.inverseChromaticAdaptation(O),R=yt([A,E,V],r.LINRGB_FROM_SCALED_DISCOUNT);if(R[0]<0||R[1]<0||R[2]<0)return 0;let Y=r.Y_FROM_LINRGB[0],q=r.Y_FROM_LINRGB[1],tt=r.Y_FROM_LINRGB[2],_=Y*R[0]+q*R[1]+tt*R[2];if(_<=0)return 0;if(y===4||Math.abs(_-n)<.002)return R[0]>100.01||R[1]>100.01||R[2]>100.01?0:Qt(R);a=a-(_-n)*a/(2*_)}return 0}static solveToInt(t,e,n){if(e<1e-4||n<1e-4||n>99.9999)return ye(n);t=z(t);let a=t/180*Math.PI,o=j(n),i=r.findResultByJ(a,e,o);if(i!==0)return i;let c=r.bisectToLimit(o,a);return Qt(c)}static solveToCam(t,e,n){return rt.fromInt(r.solveToInt(t,e,n))}};J.SCALED_DISCOUNT_FROM_LINRGB=[[.001200833568784504,.002389694492170889,.0002795742885861124],[.0005891086651375999,.0029785502573438758,.0003270666104008398],[.00010146692491640572,.0005364214359186694,.0032979401770712076]];J.LINRGB_FROM_SCALED_DISCOUNT=[[1373.2198709594231,-1100.4251190754821,-7.278681089101213],[-271.815969077903,559.6580465940733,-32.46047482791194],[1.9622899599665666,-57.173814538844006,308.7233197812385]];J.Y_FROM_LINRGB=[.2126,.7152,.0722];J.CRITICAL_PLANES=[.015176349177441876,.045529047532325624,.07588174588720938,.10623444424209313,.13658714259697685,.16693984095186062,.19729253930674434,.2276452376616281,.2579979360165119,.28835063437139563,.3188300904430532,.350925934958123,.3848314933096426,.42057480301049466,.458183274052838,.4976837250274023,.5391024159806381,.5824650784040898,.6277969426914107,.6751227633498623,.7244668422128921,.775853049866786,.829304845476233,.8848452951698498,.942497089126609,1.0022825574869039,1.0642236851973577,1.1283421258858297,1.1946592148522128,1.2631959812511864,1.3339731595349034,1.407011200216447,1.4823302800086415,1.5599503113873272,1.6398909516233677,1.7221716113234105,1.8068114625156377,1.8938294463134073,1.9832442801866852,2.075074464868551,2.1693382909216234,2.2660538449872063,2.36523901573795,2.4669114995532007,2.5710888059345764,2.6777882626779785,2.7870270208169257,2.898822059350997,3.0131901897720907,3.1301480604002863,3.2497121605402226,3.3718988244681087,3.4967242352587946,3.624204428461639,3.754355295633311,3.887192587735158,4.022731918402185,4.160988767090289,4.301978482107941,4.445716283538092,4.592217266055746,4.741496401646282,4.893568542229298,5.048448422192488,5.20615066083972,5.3666897647573375,5.5300801301023865,5.696336044816294,5.865471690767354,6.037501145825082,6.212438385869475,6.390297286737924,6.571091626112461,6.7548350853498045,6.941541251256611,7.131223617812143,7.323895587840543,7.5195704746346665,7.7182615035334345,7.919981813454504,8.124744458384042,8.332562408825165,8.543448553206703,8.757415699253682,8.974476575321063,9.194643831691977,9.417930041841839,9.644347703669503,9.873909240696694,10.106627003236781,10.342513269534024,10.58158024687427,10.8238400726681,11.069304815507364,11.317986476196008,11.569896988756009,11.825048221409341,12.083451977536606,12.345119996613247,12.610063955123938,12.878295467455942,13.149826086772048,13.42466730586372,13.702830557985108,13.984327217668513,14.269168601521828,14.55736596900856,14.848930523210871,15.143873411576273,15.44220572664832,15.743938506781891,16.04908273684337,16.35764934889634,16.66964922287304,16.985093187232053,17.30399201960269,17.62635644741625,17.95219714852476,18.281524751807332,18.614349837764564,18.95068293910138,19.290534541298456,19.633915083172692,19.98083495742689,20.331304511189067,20.685334046541502,21.042933821039977,21.404114048223256,21.76888489811322,22.137256497705877,22.50923893145328,22.884842241736916,23.264076429332462,23.6469514538663,24.033477234264016,24.42366364919083,24.817520537484558,25.21505769858089,25.61628489293138,26.021211842414342,26.429848230738664,26.842203703840827,27.258287870275353,27.678110301598522,28.10168053274597,28.529008062403893,28.96010235337422,29.39497283293396,29.83362889318845,30.276079891419332,30.722335150426627,31.172403958865512,31.62629557157785,32.08401920991837,32.54558406207592,33.010999283389665,33.4802739966603,33.953417292456834,34.430438229418264,34.911345834551085,35.39614910352207,35.88485700094671,36.37747846067349,36.87402238606382,37.37449765026789,37.87891309649659,38.38727753828926,38.89959975977785,39.41588851594697,39.93615253289054,40.460400508064545,40.98864111053629,41.520882981230194,42.05713473317016,42.597404951718396,43.141702194811224,43.6900349931913,44.24241185063697,44.798841244188324,45.35933162437017,45.92389141541209,46.49252901546552,47.065252796817916,47.64207110610409,48.22299226451468,48.808024568002054,49.3971762874833,49.9904556690408,50.587870934119984,51.189430279724725,51.79514187861014,52.40501387947288,53.0190544071392,53.637271562750364,54.259673423945976,54.88626804504493,55.517063457223934,56.15206766869424,56.79128866487574,57.43473440856916,58.08241284012621,58.734331877617365,59.39049941699807,60.05092333227251,60.715611475655585,61.38457167773311,62.057811747619894,62.7353394731159,63.417162620860914,64.10328893648692,64.79372614476921,65.48848194977529,66.18756403501224,66.89098006357258,67.59873767827808,68.31084450182222,69.02730813691093,69.74813616640164,70.47333615344107,71.20291564160104,71.93688215501312,72.67524319850172,73.41800625771542,74.16517879925733,74.9167682708136,75.67278210128072,76.43322770089146,77.1981124613393,77.96744375590167,78.74122893956174,79.51947534912904,80.30219030335869,81.08938110306934,81.88105503125999,82.67721935322541,83.4778813166706,84.28304815182372,85.09272707154808,85.90692527145302,86.72564993000343,87.54890820862819,88.3767072518277,89.2090541872801,90.04595612594655,90.88742016217518,91.73345337380438,92.58406282226491,93.43925555268066,94.29903859396902,95.16341895893969,96.03240364439274,96.9059996312159,97.78421388448044,98.6670533535366,99.55452497210776];var T=class r{static from(t,e,n){return new r(J.solveToInt(t,e,n))}static fromInt(t){return new r(t)}toInt(){return this.argb}get hue(){return this.internalHue}set hue(t){this.setInternalState(J.solveToInt(t,this.internalChroma,this.internalTone))}get chroma(){return this.internalChroma}set chroma(t){this.setInternalState(J.solveToInt(this.internalHue,t,this.internalTone))}get tone(){return this.internalTone}set tone(t){this.setInternalState(J.solveToInt(this.internalHue,this.internalChroma,t))}setValue(t,e){this[t]=e}toString(){return`HCT(${this.hue.toFixed(0)}, ${this.chroma.toFixed(0)}, ${this.tone.toFixed(0)})`}static isBlue(t){return t>=250&&t<270}static isYellow(t){return t>=105&&t<125}static isCyan(t){return t>=170&&t<207}constructor(t){this.argb=t;let e=rt.fromInt(t);this.internalHue=e.hue,this.internalChroma=e.chroma,this.internalTone=wt(t),this.argb=t}setInternalState(t){let e=rt.fromInt(t);this.internalHue=e.hue,this.internalChroma=e.chroma,this.internalTone=wt(t),this.argb=t}inViewingConditions(t){let n=rt.fromInt(this.toInt()).xyzInViewingConditions(t),a=rt.fromXyzInViewingConditions(n[0],n[1],n[2],X.make());return r.from(a.hue,a.chroma,Ct(n[1]))}};var H=class r{static ratioOfTones(t,e){return t=U(0,100,t),e=U(0,100,e),r.ratioOfYs(j(t),j(e))}static ratioOfYs(t,e){let n=t>e?t:e,a=n===e?t:e;return(n+5)/(a+5)}static lighter(t,e){if(t<0||t>100)return-1;let n=j(t),a=e*(n+5)-5,o=r.ratioOfYs(a,n),i=Math.abs(o-e);if(o<e&&i>.04)return-1;let c=Ct(a)+.4;return c<0||c>100?-1:c}static darker(t,e){if(t<0||t>100)return-1;let n=j(t),a=(n+5)/e-5,o=r.ratioOfYs(n,a),i=Math.abs(o-e);if(o<e&&i>.04)return-1;let c=Ct(a)-.4;return c<0||c>100?-1:c}static lighterUnsafe(t,e){let n=r.lighter(t,e);return n<0?100:n}static darkerUnsafe(t,e){let n=r.darker(t,e);return n<0?0:n}};var ut=class r{static isDisliked(t){let e=Math.round(t.hue)>=90&&Math.round(t.hue)<=111,n=Math.round(t.chroma)>16,a=Math.round(t.tone)<65;return e&&n&&a}static fixIfDisliked(t){return r.isDisliked(t)?T.from(t.hue,t.chroma,70):t}};function Le(r,t,e){if(r.name!==e.name)throw new Error(`Attempting to extend color ${r.name} with color ${e.name} of different name for spec version ${t}.`);if(r.isBackground!==e.isBackground)throw new Error(`Attempting to extend color ${r.name} as a ${r.isBackground?"background":"foreground"} with color ${e.name} as a ${e.isBackground?"background":"foreground"} for spec version ${t}.`)}function w(r,t,e){return Le(r,t,e),u.fromPalette({name:r.name,palette:n=>n.specVersion===t?e.palette(n):r.palette(n),tone:n=>n.specVersion===t?e.tone(n):r.tone(n),isBackground:r.isBackground,chromaMultiplier:n=>{let a=n.specVersion===t?e.chromaMultiplier:r.chromaMultiplier;return a!==void 0?a(n):1},background:n=>{let a=n.specVersion===t?e.background:r.background;return a!==void 0?a(n):void 0},secondBackground:n=>{let a=n.specVersion===t?e.secondBackground:r.secondBackground;return a!==void 0?a(n):void 0},contrastCurve:n=>{let a=n.specVersion===t?e.contrastCurve:r.contrastCurve;return a!==void 0?a(n):void 0},toneDeltaPair:n=>{let a=n.specVersion===t?e.toneDeltaPair:r.toneDeltaPair;return a!==void 0?a(n):void 0}})}var u=class r{static fromPalette(t){return new r(t.name??"",t.palette,t.tone??r.getInitialToneFromBackground(t.background),t.isBackground??!1,t.chromaMultiplier,t.background,t.secondBackground,t.contrastCurve,t.toneDeltaPair)}static getInitialToneFromBackground(t){return t===void 0?e=>50:e=>t(e)?t(e).getTone(e):50}constructor(t,e,n,a,o,i,c,f,g){if(this.name=t,this.palette=e,this.tone=n,this.isBackground=a,this.chromaMultiplier=o,this.background=i,this.secondBackground=c,this.contrastCurve=f,this.toneDeltaPair=g,this.hctCache=new Map,!i&&c)throw new Error(`Color ${t} has secondBackgrounddefined, but background is not defined.`);if(!i&&f)throw new Error(`Color ${t} has contrastCurvedefined, but background is not defined.`);if(i&&!f)throw new Error(`Color ${t} has backgrounddefined, but contrastCurve is not defined.`)}clone(){return r.fromPalette({name:this.name,palette:this.palette,tone:this.tone,isBackground:this.isBackground,chromaMultiplier:this.chromaMultiplier,background:this.background,secondBackground:this.secondBackground,contrastCurve:this.contrastCurve,toneDeltaPair:this.toneDeltaPair})}clearCache(){this.hctCache.clear()}getArgb(t){return this.getHct(t).toInt()}getHct(t){let e=this.hctCache.get(t);if(e!=null)return e;let n=Ce(t.specVersion).getHct(t,this);return this.hctCache.size>4&&this.hctCache.clear(),this.hctCache.set(t,n),n}getTone(t){return Ce(t.specVersion).getTone(t,this)}static foregroundTone(t,e){let n=H.lighterUnsafe(t,e),a=H.darkerUnsafe(t,e),o=H.ratioOfTones(n,t),i=H.ratioOfTones(a,t);if(r.tonePrefersLightForeground(t)){let f=Math.abs(o-i)<.1&&o<e&&i<e;return o>=e||o>=i||f?n:a}else return i>=e||i>=o?a:n}static tonePrefersLightForeground(t){return Math.round(t)<60}static toneAllowsLightForeground(t){return Math.round(t)<=49}static enableLightForeground(t){return r.tonePrefersLightForeground(t)&&!r.toneAllowsLightForeground(t)?49:t}},ee=class{getHct(t,e){let n=e.getTone(t);return e.palette(t).getHct(n)}getTone(t,e){let n=t.contrastLevel<0,a=e.toneDeltaPair?e.toneDeltaPair(t):void 0;if(a){let o=a.roleA,i=a.roleB,c=a.delta,f=a.polarity,g=a.stayTogether,m=f==="nearer"||f==="lighter"&&!t.isDark||f==="darker"&&t.isDark,y=m?o:i,P=m?i:o,d=e.name===y.name,p=t.isDark?1:-1,l=y.tone(t),C=P.tone(t);if(e.background&&y.contrastCurve&&P.contrastCurve){let v=e.background(t),S=y.contrastCurve(t),k=P.contrastCurve(t);if(v&&S&&k){let I=v.getTone(t),L=S.get(t.contrastLevel),O=k.get(t.contrastLevel);H.ratioOfTones(I,l)<L&&(l=u.foregroundTone(I,L)),H.ratioOfTones(I,C)<O&&(C=u.foregroundTone(I,O)),n&&(l=u.foregroundTone(I,L),C=u.foregroundTone(I,O))}}return(C-l)*p<c&&(C=U(0,100,l+c*p),(C-l)*p>=c||(l=U(0,100,C-c*p))),50<=l&&l<60?p>0?(l=60,C=Math.max(C,l+c*p)):(l=49,C=Math.min(C,l+c*p)):50<=C&&C<60&&(g?p>0?(l=60,C=Math.max(C,l+c*p)):(l=49,C=Math.min(C,l+c*p)):p>0?C=60:C=49),d?l:C}else{let o=e.tone(t);if(e.background==null||e.background(t)===void 0||e.contrastCurve==null||e.contrastCurve(t)===void 0)return o;let i=e.background(t).getTone(t),c=e.contrastCurve(t).get(t.contrastLevel);if(H.ratioOfTones(i,o)>=c||(o=u.foregroundTone(i,c)),n&&(o=u.foregroundTone(i,c)),e.isBackground&&50<=o&&o<60&&(H.ratioOfTones(49,i)>=c?o=49:o=60),e.secondBackground==null||e.secondBackground(t)===void 0)return o;let[f,g]=[e.background,e.secondBackground],[m,y]=[f(t).getTone(t),g(t).getTone(t)],[P,d]=[Math.max(m,y),Math.min(m,y)];if(H.ratioOfTones(P,o)>=c&&H.ratioOfTones(d,o)>=c)return o;let p=H.lighter(P,c),l=H.darker(d,c),C=[];return p!==-1&&C.push(p),l!==-1&&C.push(l),u.tonePrefersLightForeground(m)||u.tonePrefersLightForeground(y)?p<0?100:p:C.length===1?C[0]:l<0?0:l}}},re=class{getHct(t,e){let n=e.palette(t),a=e.getTone(t),o=n.hue,i=n.chroma*(e.chromaMultiplier?e.chromaMultiplier(t):1);return T.from(o,i,a)}getTone(t,e){let n=e.toneDeltaPair?e.toneDeltaPair(t):void 0;if(n){let a=n.roleA,o=n.roleB,i=n.polarity,c=n.constraint,f=i==="darker"||i==="relative_lighter"&&t.isDark||i==="relative_darker"&&!t.isDark?-n.delta:n.delta,g=e.name===a.name,m=g?a:o,y=g?o:a,P=m.tone(t),d=y.getTone(t),p=f*(g?1:-1);if(c==="exact"?P=U(0,100,d+p):c==="nearer"?p>0?P=U(0,100,U(d,d+p,P)):P=U(0,100,U(d+p,d,P)):c==="farther"&&(p>0?P=U(d+p,100,P):P=U(0,d+p,P)),e.background&&e.contrastCurve){let l=e.background(t),C=e.contrastCurve(t);if(l&&C){let v=l.getTone(t),S=C.get(t.contrastLevel);P=H.ratioOfTones(v,P)>=S&&t.contrastLevel>=0?P:u.foregroundTone(v,S)}}return e.isBackground&&!e.name.endsWith("_fixed_dim")&&(P>=57?P=U(65,100,P):P=U(0,49,P)),P}else{let a=e.tone(t);if(e.background==null||e.background(t)===void 0||e.contrastCurve==null||e.contrastCurve(t)===void 0)return a;let o=e.background(t).getTone(t),i=e.contrastCurve(t).get(t.contrastLevel);if(a=H.ratioOfTones(o,a)>=i&&t.contrastLevel>=0?a:u.foregroundTone(o,i),e.isBackground&&!e.name.endsWith("_fixed_dim")&&(a>=57?a=U(65,100,a):a=U(0,49,a)),e.secondBackground==null||e.secondBackground(t)===void 0)return a;let[c,f]=[e.background,e.secondBackground],[g,m]=[c(t).getTone(t),f(t).getTone(t)],[y,P]=[Math.max(g,m),Math.min(g,m)];if(H.ratioOfTones(y,a)>=i&&H.ratioOfTones(P,a)>=i)return a;let d=H.lighter(y,i),p=H.darker(P,i),l=[];return d!==-1&&l.push(d),p!==-1&&l.push(p),u.tonePrefersLightForeground(g)||u.tonePrefersLightForeground(m)?d<0?100:d:l.length===1?l[0]:p<0?0:p}}},Oe=new ee,Ve=new re;function Ce(r){return r==="2025"?Ve:Oe}var x=class r{static fromInt(t){let e=T.fromInt(t);return r.fromHct(e)}static fromHct(t){return new r(t.hue,t.chroma,t)}static fromHueAndChroma(t,e){let n=new ne(t,e).create();return new r(t,e,n)}constructor(t,e,n){this.hue=t,this.chroma=e,this.keyColor=n,this.cache=new Map}tone(t){let e=this.cache.get(t);return e===void 0&&(t==99&&T.isYellow(this.hue)?e=this.averageArgb(this.tone(98),this.tone(100)):e=T.from(this.hue,this.chroma,t).toInt(),this.cache.set(t,e)),e}getHct(t){return T.fromInt(this.tone(t))}averageArgb(t,e){let n=t>>>16&255,a=t>>>8&255,o=t&255,i=e>>>16&255,c=e>>>8&255,f=e&255,g=Math.round((n+i)/2),m=Math.round((a+c)/2),y=Math.round((o+f)/2);return(255<<24|(g&255)<<16|(m&255)<<8|y&255)>>>0}},ne=class{constructor(t,e){this.hue=t,this.requestedChroma=e,this.chromaCache=new Map,this.maxChromaValue=200}create(){let a=0,o=100;for(;a<o;){let i=Math.floor((a+o)/2),c=this.maxChroma(i)<this.maxChroma(i+1);if(this.maxChroma(i)>=this.requestedChroma-.01)if(Math.abs(a-50)<Math.abs(o-50))o=i;else{if(a===i)return T.from(this.hue,this.requestedChroma,a);a=i}else c?a=i+1:o=i}return T.from(this.hue,this.requestedChroma,a)}maxChroma(t){if(this.chromaCache.has(t))return this.chromaCache.get(t);let e=T.from(this.hue,this.maxChromaValue,t).chroma;return this.chromaCache.set(t,e),e}};var St=class r{constructor(t){this.input=t,this.hctsByTempCache=[],this.hctsByHueCache=[],this.tempsByHctCache=new Map,this.inputRelativeTemperatureCache=-1,this.complementCache=null}get hctsByTemp(){if(this.hctsByTempCache.length>0)return this.hctsByTempCache;let t=this.hctsByHue.concat([this.input]),e=this.tempsByHct;return t.sort((n,a)=>e.get(n)-e.get(a)),this.hctsByTempCache=t,t}get warmest(){return this.hctsByTemp[this.hctsByTemp.length-1]}get coldest(){return this.hctsByTemp[0]}analogous(t=5,e=12){let n=Math.round(this.input.hue),a=this.hctsByHue[n],o=this.relativeTemperature(a),i=[a],c=0;for(let p=0;p<360;p++){let l=lt(n+p),C=this.hctsByHue[l],v=this.relativeTemperature(C),S=Math.abs(v-o);o=v,c+=S}let f=1,g=c/e,m=0;for(o=this.relativeTemperature(a);i.length<e;){let p=lt(n+f),l=this.hctsByHue[p],C=this.relativeTemperature(l),v=Math.abs(C-o);m+=v;let S=i.length*g,k=m>=S,I=1;for(;k&&i.length<e;){i.push(l);let L=(i.length+I)*g;k=m>=L,I++}if(o=C,f++,f>360){for(;i.length<e;)i.push(l);break}}let y=[this.input],P=Math.floor((t-1)/2);for(let p=1;p<P+1;p++){let l=0-p;for(;l<0;)l=i.length+l;l>=i.length&&(l=l%i.length),y.splice(0,0,i[l])}let d=t-P-1;for(let p=1;p<d+1;p++){let l=p;for(;l<0;)l=i.length+l;l>=i.length&&(l=l%i.length),y.push(i[l])}return y}get complement(){if(this.complementCache!=null)return this.complementCache;let t=this.coldest.hue,e=this.tempsByHct.get(this.coldest),n=this.warmest.hue,o=this.tempsByHct.get(this.warmest)-e,i=r.isBetween(this.input.hue,t,n),c=i?n:t,f=i?t:n,g=1,m=1e3,y=this.hctsByHue[Math.round(this.input.hue)],P=1-this.inputRelativeTemperature;for(let d=0;d<=360;d+=1){let p=z(c+g*d);if(!r.isBetween(p,c,f))continue;let l=this.hctsByHue[Math.round(p)],C=(this.tempsByHct.get(l)-e)/o,v=Math.abs(P-C);v<m&&(m=v,y=l)}return this.complementCache=y,this.complementCache}relativeTemperature(t){let e=this.tempsByHct.get(this.warmest)-this.tempsByHct.get(this.coldest),n=this.tempsByHct.get(t)-this.tempsByHct.get(this.coldest);return e===0?.5:n/e}get inputRelativeTemperature(){return this.inputRelativeTemperatureCache>=0?this.inputRelativeTemperatureCache:(this.inputRelativeTemperatureCache=this.relativeTemperature(this.input),this.inputRelativeTemperatureCache)}get tempsByHct(){if(this.tempsByHctCache.size>0)return this.tempsByHctCache;let t=this.hctsByHue.concat([this.input]),e=new Map;for(let n of t)e.set(n,r.rawTemperature(n));return this.tempsByHctCache=e,e}get hctsByHue(){if(this.hctsByHueCache.length>0)return this.hctsByHueCache;let t=[];for(let e=0;e<=360;e+=1){let n=T.from(e,this.input.chroma,this.input.tone);t.push(n)}return this.hctsByHueCache=t,this.hctsByHueCache}static isBetween(t,e,n){return e<n?e<=t&&t<=n:e<=t||t<=n}static rawTemperature(t){let e=Ft(t.toInt()),n=z(Math.atan2(e[2],e[1])*180/Math.PI),a=Math.sqrt(e[1]*e[1]+e[2]*e[2]);return-.5+.02*Math.pow(a,1.07)*Math.cos(z(n-50)*Math.PI/180)}};var D=class{constructor(t,e,n,a){this.low=t,this.normal=e,this.medium=n,this.high=a}get(t){return t<=-1?this.low:t<0?st(this.low,this.normal,(t- -1)/1):t<.5?st(this.normal,this.medium,(t-0)/.5):t<1?st(this.medium,this.high,(t-.5)/.5):this.high}};var B=class{constructor(t,e,n,a,o,i){this.roleA=t,this.roleB=e,this.delta=n,this.polarity=a,this.stayTogether=o,this.constraint=i,this.constraint=i??"exact"}};var s;(function(r){r[r.MONOCHROME=0]="MONOCHROME",r[r.NEUTRAL=1]="NEUTRAL",r[r.TONAL_SPOT=2]="TONAL_SPOT",r[r.VIBRANT=3]="VIBRANT",r[r.EXPRESSIVE=4]="EXPRESSIVE",r[r.FIDELITY=5]="FIDELITY",r[r.CONTENT=6]="CONTENT",r[r.RAINBOW=7]="RAINBOW",r[r.FRUIT_SALAD=8]="FRUIT_SALAD"})(s||(s={}));function dt(r){return r.variant===s.FIDELITY||r.variant===s.CONTENT}function N(r){return r.variant===s.MONOCHROME}function Ne(r,t,e,n){let a=e,o=T.from(r,t,e);if(o.chroma<t){let i=o.chroma;for(;o.chroma<t;){a+=n?-1:1;let c=T.from(r,t,a);if(i>c.chroma||Math.abs(c.chroma-t)<.4)break;let f=Math.abs(c.chroma-t),g=Math.abs(o.chroma-t);f<g&&(o=c),i=Math.max(i,c.chroma)}}return a}var vt=class{primaryPaletteKeyColor(){return u.fromPalette({name:"primary_palette_key_color",palette:t=>t.primaryPalette,tone:t=>t.primaryPalette.keyColor.tone})}secondaryPaletteKeyColor(){return u.fromPalette({name:"secondary_palette_key_color",palette:t=>t.secondaryPalette,tone:t=>t.secondaryPalette.keyColor.tone})}tertiaryPaletteKeyColor(){return u.fromPalette({name:"tertiary_palette_key_color",palette:t=>t.tertiaryPalette,tone:t=>t.tertiaryPalette.keyColor.tone})}neutralPaletteKeyColor(){return u.fromPalette({name:"neutral_palette_key_color",palette:t=>t.neutralPalette,tone:t=>t.neutralPalette.keyColor.tone})}neutralVariantPaletteKeyColor(){return u.fromPalette({name:"neutral_variant_palette_key_color",palette:t=>t.neutralVariantPalette,tone:t=>t.neutralVariantPalette.keyColor.tone})}errorPaletteKeyColor(){return u.fromPalette({name:"error_palette_key_color",palette:t=>t.errorPalette,tone:t=>t.errorPalette.keyColor.tone})}background(){return u.fromPalette({name:"background",palette:t=>t.neutralPalette,tone:t=>t.isDark?6:98,isBackground:!0})}onBackground(){return u.fromPalette({name:"on_background",palette:t=>t.neutralPalette,tone:t=>t.isDark?90:10,background:t=>this.background(),contrastCurve:t=>new D(3,3,4.5,7)})}surface(){return u.fromPalette({name:"surface",palette:t=>t.neutralPalette,tone:t=>t.isDark?6:98,isBackground:!0})}surfaceDim(){return u.fromPalette({name:"surface_dim",palette:t=>t.neutralPalette,tone:t=>t.isDark?6:new D(87,87,80,75).get(t.contrastLevel),isBackground:!0})}surfaceBright(){return u.fromPalette({name:"surface_bright",palette:t=>t.neutralPalette,tone:t=>t.isDark?new D(24,24,29,34).get(t.contrastLevel):98,isBackground:!0})}surfaceContainerLowest(){return u.fromPalette({name:"surface_container_lowest",palette:t=>t.neutralPalette,tone:t=>t.isDark?new D(4,4,2,0).get(t.contrastLevel):100,isBackground:!0})}surfaceContainerLow(){return u.fromPalette({name:"surface_container_low",palette:t=>t.neutralPalette,tone:t=>t.isDark?new D(10,10,11,12).get(t.contrastLevel):new D(96,96,96,95).get(t.contrastLevel),isBackground:!0})}surfaceContainer(){return u.fromPalette({name:"surface_container",palette:t=>t.neutralPalette,tone:t=>t.isDark?new D(12,12,16,20).get(t.contrastLevel):new D(94,94,92,90).get(t.contrastLevel),isBackground:!0})}surfaceContainerHigh(){return u.fromPalette({name:"surface_container_high",palette:t=>t.neutralPalette,tone:t=>t.isDark?new D(17,17,21,25).get(t.contrastLevel):new D(92,92,88,85).get(t.contrastLevel),isBackground:!0})}surfaceContainerHighest(){return u.fromPalette({name:"surface_container_highest",palette:t=>t.neutralPalette,tone:t=>t.isDark?new D(22,22,26,30).get(t.contrastLevel):new D(90,90,84,80).get(t.contrastLevel),isBackground:!0})}onSurface(){return u.fromPalette({name:"on_surface",palette:t=>t.neutralPalette,tone:t=>t.isDark?90:10,background:t=>this.highestSurface(t),contrastCurve:t=>new D(4.5,7,11,21)})}surfaceVariant(){return u.fromPalette({name:"surface_variant",palette:t=>t.neutralVariantPalette,tone:t=>t.isDark?30:90,isBackground:!0})}onSurfaceVariant(){return u.fromPalette({name:"on_surface_variant",palette:t=>t.neutralVariantPalette,tone:t=>t.isDark?80:30,background:t=>this.highestSurface(t),contrastCurve:t=>new D(3,4.5,7,11)})}inverseSurface(){return u.fromPalette({name:"inverse_surface",palette:t=>t.neutralPalette,tone:t=>t.isDark?90:20,isBackground:!0})}inverseOnSurface(){return u.fromPalette({name:"inverse_on_surface",palette:t=>t.neutralPalette,tone:t=>t.isDark?20:95,background:t=>this.inverseSurface(),contrastCurve:t=>new D(4.5,7,11,21)})}outline(){return u.fromPalette({name:"outline",palette:t=>t.neutralVariantPalette,tone:t=>t.isDark?60:50,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1.5,3,4.5,7)})}outlineVariant(){return u.fromPalette({name:"outline_variant",palette:t=>t.neutralVariantPalette,tone:t=>t.isDark?30:80,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5)})}shadow(){return u.fromPalette({name:"shadow",palette:t=>t.neutralPalette,tone:t=>0})}scrim(){return u.fromPalette({name:"scrim",palette:t=>t.neutralPalette,tone:t=>0})}surfaceTint(){return u.fromPalette({name:"surface_tint",palette:t=>t.primaryPalette,tone:t=>t.isDark?80:40,isBackground:!0})}primary(){return u.fromPalette({name:"primary",palette:t=>t.primaryPalette,tone:t=>N(t)?t.isDark?100:0:t.isDark?80:40,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(3,4.5,7,7),toneDeltaPair:t=>new B(this.primaryContainer(),this.primary(),10,"nearer",!1)})}primaryDim(){}onPrimary(){return u.fromPalette({name:"on_primary",palette:t=>t.primaryPalette,tone:t=>N(t)?t.isDark?10:90:t.isDark?20:100,background:t=>this.primary(),contrastCurve:t=>new D(4.5,7,11,21)})}primaryContainer(){return u.fromPalette({name:"primary_container",palette:t=>t.primaryPalette,tone:t=>dt(t)?t.sourceColorHct.tone:N(t)?t.isDark?85:25:t.isDark?30:90,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.primaryContainer(),this.primary(),10,"nearer",!1)})}onPrimaryContainer(){return u.fromPalette({name:"on_primary_container",palette:t=>t.primaryPalette,tone:t=>dt(t)?u.foregroundTone(this.primaryContainer().tone(t),4.5):N(t)?t.isDark?0:100:t.isDark?90:30,background:t=>this.primaryContainer(),contrastCurve:t=>new D(3,4.5,7,11)})}inversePrimary(){return u.fromPalette({name:"inverse_primary",palette:t=>t.primaryPalette,tone:t=>t.isDark?40:80,background:t=>this.inverseSurface(),contrastCurve:t=>new D(3,4.5,7,7)})}secondary(){return u.fromPalette({name:"secondary",palette:t=>t.secondaryPalette,tone:t=>t.isDark?80:40,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(3,4.5,7,7),toneDeltaPair:t=>new B(this.secondaryContainer(),this.secondary(),10,"nearer",!1)})}secondaryDim(){}onSecondary(){return u.fromPalette({name:"on_secondary",palette:t=>t.secondaryPalette,tone:t=>N(t)?t.isDark?10:100:t.isDark?20:100,background:t=>this.secondary(),contrastCurve:t=>new D(4.5,7,11,21)})}secondaryContainer(){return u.fromPalette({name:"secondary_container",palette:t=>t.secondaryPalette,tone:t=>{let e=t.isDark?30:90;return N(t)?t.isDark?30:85:dt(t)?Ne(t.secondaryPalette.hue,t.secondaryPalette.chroma,e,!t.isDark):e},isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.secondaryContainer(),this.secondary(),10,"nearer",!1)})}onSecondaryContainer(){return u.fromPalette({name:"on_secondary_container",palette:t=>t.secondaryPalette,tone:t=>N(t)?t.isDark?90:10:dt(t)?u.foregroundTone(this.secondaryContainer().tone(t),4.5):t.isDark?90:30,background:t=>this.secondaryContainer(),contrastCurve:t=>new D(3,4.5,7,11)})}tertiary(){return u.fromPalette({name:"tertiary",palette:t=>t.tertiaryPalette,tone:t=>N(t)?t.isDark?90:25:t.isDark?80:40,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(3,4.5,7,7),toneDeltaPair:t=>new B(this.tertiaryContainer(),this.tertiary(),10,"nearer",!1)})}tertiaryDim(){}onTertiary(){return u.fromPalette({name:"on_tertiary",palette:t=>t.tertiaryPalette,tone:t=>N(t)?t.isDark?10:90:t.isDark?20:100,background:t=>this.tertiary(),contrastCurve:t=>new D(4.5,7,11,21)})}tertiaryContainer(){return u.fromPalette({name:"tertiary_container",palette:t=>t.tertiaryPalette,tone:t=>{if(N(t))return t.isDark?60:49;if(!dt(t))return t.isDark?30:90;let e=t.tertiaryPalette.getHct(t.sourceColorHct.tone);return ut.fixIfDisliked(e).tone},isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.tertiaryContainer(),this.tertiary(),10,"nearer",!1)})}onTertiaryContainer(){return u.fromPalette({name:"on_tertiary_container",palette:t=>t.tertiaryPalette,tone:t=>N(t)?t.isDark?0:100:dt(t)?u.foregroundTone(this.tertiaryContainer().tone(t),4.5):t.isDark?90:30,background:t=>this.tertiaryContainer(),contrastCurve:t=>new D(3,4.5,7,11)})}error(){return u.fromPalette({name:"error",palette:t=>t.errorPalette,tone:t=>t.isDark?80:40,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(3,4.5,7,7),toneDeltaPair:t=>new B(this.errorContainer(),this.error(),10,"nearer",!1)})}errorDim(){}onError(){return u.fromPalette({name:"on_error",palette:t=>t.errorPalette,tone:t=>t.isDark?20:100,background:t=>this.error(),contrastCurve:t=>new D(4.5,7,11,21)})}errorContainer(){return u.fromPalette({name:"error_container",palette:t=>t.errorPalette,tone:t=>t.isDark?30:90,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.errorContainer(),this.error(),10,"nearer",!1)})}onErrorContainer(){return u.fromPalette({name:"on_error_container",palette:t=>t.errorPalette,tone:t=>N(t)?t.isDark?90:10:t.isDark?90:30,background:t=>this.errorContainer(),contrastCurve:t=>new D(3,4.5,7,11)})}primaryFixed(){return u.fromPalette({name:"primary_fixed",palette:t=>t.primaryPalette,tone:t=>N(t)?40:90,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.primaryFixed(),this.primaryFixedDim(),10,"lighter",!0)})}primaryFixedDim(){return u.fromPalette({name:"primary_fixed_dim",palette:t=>t.primaryPalette,tone:t=>N(t)?30:80,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.primaryFixed(),this.primaryFixedDim(),10,"lighter",!0)})}onPrimaryFixed(){return u.fromPalette({name:"on_primary_fixed",palette:t=>t.primaryPalette,tone:t=>N(t)?100:10,background:t=>this.primaryFixedDim(),secondBackground:t=>this.primaryFixed(),contrastCurve:t=>new D(4.5,7,11,21)})}onPrimaryFixedVariant(){return u.fromPalette({name:"on_primary_fixed_variant",palette:t=>t.primaryPalette,tone:t=>N(t)?90:30,background:t=>this.primaryFixedDim(),secondBackground:t=>this.primaryFixed(),contrastCurve:t=>new D(3,4.5,7,11)})}secondaryFixed(){return u.fromPalette({name:"secondary_fixed",palette:t=>t.secondaryPalette,tone:t=>N(t)?80:90,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.secondaryFixed(),this.secondaryFixedDim(),10,"lighter",!0)})}secondaryFixedDim(){return u.fromPalette({name:"secondary_fixed_dim",palette:t=>t.secondaryPalette,tone:t=>N(t)?70:80,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.secondaryFixed(),this.secondaryFixedDim(),10,"lighter",!0)})}onSecondaryFixed(){return u.fromPalette({name:"on_secondary_fixed",palette:t=>t.secondaryPalette,tone:t=>10,background:t=>this.secondaryFixedDim(),secondBackground:t=>this.secondaryFixed(),contrastCurve:t=>new D(4.5,7,11,21)})}onSecondaryFixedVariant(){return u.fromPalette({name:"on_secondary_fixed_variant",palette:t=>t.secondaryPalette,tone:t=>N(t)?25:30,background:t=>this.secondaryFixedDim(),secondBackground:t=>this.secondaryFixed(),contrastCurve:t=>new D(3,4.5,7,11)})}tertiaryFixed(){return u.fromPalette({name:"tertiary_fixed",palette:t=>t.tertiaryPalette,tone:t=>N(t)?40:90,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.tertiaryFixed(),this.tertiaryFixedDim(),10,"lighter",!0)})}tertiaryFixedDim(){return u.fromPalette({name:"tertiary_fixed_dim",palette:t=>t.tertiaryPalette,tone:t=>N(t)?30:80,isBackground:!0,background:t=>this.highestSurface(t),contrastCurve:t=>new D(1,1,3,4.5),toneDeltaPair:t=>new B(this.tertiaryFixed(),this.tertiaryFixedDim(),10,"lighter",!0)})}onTertiaryFixed(){return u.fromPalette({name:"on_tertiary_fixed",palette:t=>t.tertiaryPalette,tone:t=>N(t)?100:10,background:t=>this.tertiaryFixedDim(),secondBackground:t=>this.tertiaryFixed(),contrastCurve:t=>new D(4.5,7,11,21)})}onTertiaryFixedVariant(){return u.fromPalette({name:"on_tertiary_fixed_variant",palette:t=>t.tertiaryPalette,tone:t=>N(t)?90:30,background:t=>this.tertiaryFixedDim(),secondBackground:t=>this.tertiaryFixed(),contrastCurve:t=>new D(3,4.5,7,11)})}highestSurface(t){return t.isDark?this.surfaceBright():this.surfaceDim()}};function M(r,t=0,e=100,n=1){let a=Se(r.hue,r.chroma*n,100,!0);return U(t,e,a)}function ot(r,t=0,e=100){let n=Se(r.hue,r.chroma,0,!1);return U(t,e,n)}function Se(r,t,e,n){let a=e,o=T.from(r,t,a);for(;o.chroma<t&&!(e<0||e>100);){e+=n?-1:1;let i=T.from(r,t,e);o.chroma<i.chroma&&(o=i,a=e)}return a}function b(r){return r===1.5?new D(1.5,1.5,3,5.5):r===3?new D(3,3,4.5,7):r===4.5?new D(4.5,4.5,7,11):r===6?new D(6,6,7,11):r===7?new D(7,7,11,21):r===9?new D(9,9,11,21):r===11?new D(11,11,21,21):r===21?new D(21,21,21,21):new D(r,r,7,21)}var Et=class extends vt{surface(){let t=u.fromPalette({name:"surface",palette:e=>e.neutralPalette,tone:e=>(super.surface().tone(e),e.platform==="phone"?e.isDark?4:T.isYellow(e.neutralPalette.hue)?99:e.variant===s.VIBRANT?97:98:0),isBackground:!0});return w(super.surface(),"2025",t)}surfaceDim(){let t=u.fromPalette({name:"surface_dim",palette:e=>e.neutralPalette,tone:e=>e.isDark?4:T.isYellow(e.neutralPalette.hue)?90:e.variant===s.VIBRANT?85:87,isBackground:!0,chromaMultiplier:e=>{if(!e.isDark){if(e.variant===s.NEUTRAL)return 2.5;if(e.variant===s.TONAL_SPOT)return 1.7;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?2.7:1.75;if(e.variant===s.VIBRANT)return 1.36}return 1}});return w(super.surfaceDim(),"2025",t)}surfaceBright(){let t=u.fromPalette({name:"surface_bright",palette:e=>e.neutralPalette,tone:e=>e.isDark?18:T.isYellow(e.neutralPalette.hue)?99:e.variant===s.VIBRANT?97:98,isBackground:!0,chromaMultiplier:e=>{if(e.isDark){if(e.variant===s.NEUTRAL)return 2.5;if(e.variant===s.TONAL_SPOT)return 1.7;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?2.7:1.75;if(e.variant===s.VIBRANT)return 1.36}return 1}});return w(super.surfaceBright(),"2025",t)}surfaceContainerLowest(){let t=u.fromPalette({name:"surface_container_lowest",palette:e=>e.neutralPalette,tone:e=>e.isDark?0:100,isBackground:!0});return w(super.surfaceContainerLowest(),"2025",t)}surfaceContainerLow(){let t=u.fromPalette({name:"surface_container_low",palette:e=>e.neutralPalette,tone:e=>e.platform==="phone"?e.isDark?6:T.isYellow(e.neutralPalette.hue)?98:e.variant===s.VIBRANT?95:96:15,isBackground:!0,chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 1.3;if(e.variant===s.TONAL_SPOT)return 1.25;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?1.3:1.15;if(e.variant===s.VIBRANT)return 1.08}return 1}});return w(super.surfaceContainerLow(),"2025",t)}surfaceContainer(){let t=u.fromPalette({name:"surface_container",palette:e=>e.neutralPalette,tone:e=>e.platform==="phone"?e.isDark?9:T.isYellow(e.neutralPalette.hue)?96:e.variant===s.VIBRANT?92:94:20,isBackground:!0,chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 1.6;if(e.variant===s.TONAL_SPOT)return 1.4;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?1.6:1.3;if(e.variant===s.VIBRANT)return 1.15}return 1}});return w(super.surfaceContainer(),"2025",t)}surfaceContainerHigh(){let t=u.fromPalette({name:"surface_container_high",palette:e=>e.neutralPalette,tone:e=>e.platform==="phone"?e.isDark?12:T.isYellow(e.neutralPalette.hue)?94:e.variant===s.VIBRANT?90:92:25,isBackground:!0,chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 1.9;if(e.variant===s.TONAL_SPOT)return 1.5;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?1.95:1.45;if(e.variant===s.VIBRANT)return 1.22}return 1}});return w(super.surfaceContainerHigh(),"2025",t)}surfaceContainerHighest(){let t=u.fromPalette({name:"surface_container_highest",palette:e=>e.neutralPalette,tone:e=>e.isDark?15:T.isYellow(e.neutralPalette.hue)?92:e.variant===s.VIBRANT?88:90,isBackground:!0,chromaMultiplier:e=>e.variant===s.NEUTRAL?2.2:e.variant===s.TONAL_SPOT?1.7:e.variant===s.EXPRESSIVE?T.isYellow(e.neutralPalette.hue)?2.3:1.6:e.variant===s.VIBRANT?1.29:1});return w(super.surfaceContainerHighest(),"2025",t)}onSurface(){let t=u.fromPalette({name:"on_surface",palette:e=>e.neutralPalette,tone:e=>e.variant===s.VIBRANT?M(e.neutralPalette,0,100,1.1):u.getInitialToneFromBackground(n=>n.platform==="phone"?this.highestSurface(n):this.surfaceContainerHigh())(e),chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 2.2;if(e.variant===s.TONAL_SPOT)return 1.7;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?e.isDark?3:2.3:1.6}return 1},background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.isDark&&e.platform==="phone"?b(11):b(9)});return w(super.onSurface(),"2025",t)}onSurfaceVariant(){let t=u.fromPalette({name:"on_surface_variant",palette:e=>e.neutralPalette,chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 2.2;if(e.variant===s.TONAL_SPOT)return 1.7;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?e.isDark?3:2.3:1.6}return 1},background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?e.isDark?b(6):b(4.5):b(7)});return w(super.onSurfaceVariant(),"2025",t)}outline(){let t=u.fromPalette({name:"outline",palette:e=>e.neutralPalette,chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 2.2;if(e.variant===s.TONAL_SPOT)return 1.7;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?e.isDark?3:2.3:1.6}return 1},background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?b(3):b(4.5)});return w(super.outline(),"2025",t)}outlineVariant(){let t=u.fromPalette({name:"outline_variant",palette:e=>e.neutralPalette,chromaMultiplier:e=>{if(e.platform==="phone"){if(e.variant===s.NEUTRAL)return 2.2;if(e.variant===s.TONAL_SPOT)return 1.7;if(e.variant===s.EXPRESSIVE)return T.isYellow(e.neutralPalette.hue)?e.isDark?3:2.3:1.6}return 1},background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?b(1.5):b(3)});return w(super.outlineVariant(),"2025",t)}inverseSurface(){let t=u.fromPalette({name:"inverse_surface",palette:e=>e.neutralPalette,tone:e=>e.isDark?98:4,isBackground:!0});return w(super.inverseSurface(),"2025",t)}inverseOnSurface(){let t=u.fromPalette({name:"inverse_on_surface",palette:e=>e.neutralPalette,background:e=>this.inverseSurface(),contrastCurve:e=>b(7)});return w(super.inverseOnSurface(),"2025",t)}primary(){let t=u.fromPalette({name:"primary",palette:e=>e.primaryPalette,tone:e=>e.variant===s.NEUTRAL?e.platform==="phone"?e.isDark?80:40:90:e.variant===s.TONAL_SPOT?e.platform==="phone"?e.isDark?80:M(e.primaryPalette):M(e.primaryPalette,0,90):e.variant===s.EXPRESSIVE?e.platform==="phone"?M(e.primaryPalette,0,T.isYellow(e.primaryPalette.hue)?25:T.isCyan(e.primaryPalette.hue)?88:98):M(e.primaryPalette):e.platform==="phone"?M(e.primaryPalette,0,T.isCyan(e.primaryPalette.hue)?88:98):M(e.primaryPalette),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?b(4.5):b(7),toneDeltaPair:e=>e.platform==="phone"?new B(this.primaryContainer(),this.primary(),5,"relative_lighter",!0,"farther"):void 0});return w(super.primary(),"2025",t)}primaryDim(){return u.fromPalette({name:"primary_dim",palette:t=>t.primaryPalette,tone:t=>t.variant===s.NEUTRAL?85:t.variant===s.TONAL_SPOT?M(t.primaryPalette,0,90):M(t.primaryPalette),isBackground:!0,background:t=>this.surfaceContainerHigh(),contrastCurve:t=>b(4.5),toneDeltaPair:t=>new B(this.primaryDim(),this.primary(),5,"darker",!0,"farther")})}onPrimary(){let t=u.fromPalette({name:"on_primary",palette:e=>e.primaryPalette,background:e=>e.platform==="phone"?this.primary():this.primaryDim(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onPrimary(),"2025",t)}primaryContainer(){let t=u.fromPalette({name:"primary_container",palette:e=>e.primaryPalette,tone:e=>e.platform==="watch"?30:e.variant===s.NEUTRAL?e.isDark?30:90:e.variant===s.TONAL_SPOT?e.isDark?ot(e.primaryPalette,35,93):M(e.primaryPalette,0,90):e.variant===s.EXPRESSIVE?e.isDark?M(e.primaryPalette,30,93):M(e.primaryPalette,78,T.isCyan(e.primaryPalette.hue)?88:90):e.isDark?ot(e.primaryPalette,66,93):M(e.primaryPalette,66,T.isCyan(e.primaryPalette.hue)?88:93),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,toneDeltaPair:e=>e.platform==="phone"?void 0:new B(this.primaryContainer(),this.primaryDim(),10,"darker",!0,"farther"),contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.primaryContainer(),"2025",t)}onPrimaryContainer(){let t=u.fromPalette({name:"on_primary_container",palette:e=>e.primaryPalette,background:e=>this.primaryContainer(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onPrimaryContainer(),"2025",t)}primaryFixed(){let t=u.fromPalette({name:"primary_fixed",palette:e=>e.primaryPalette,tone:e=>{let n=Object.assign({},e,{isDark:!1,contrastLevel:0});return this.primaryContainer().getTone(n)},isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.primaryFixed(),"2025",t)}primaryFixedDim(){let t=u.fromPalette({name:"primary_fixed_dim",palette:e=>e.primaryPalette,tone:e=>this.primaryFixed().getTone(e),isBackground:!0,toneDeltaPair:e=>new B(this.primaryFixedDim(),this.primaryFixed(),5,"darker",!0,"exact")});return w(super.primaryFixedDim(),"2025",t)}onPrimaryFixed(){let t=u.fromPalette({name:"on_primary_fixed",palette:e=>e.primaryPalette,background:e=>this.primaryFixedDim(),contrastCurve:e=>b(7)});return w(super.onPrimaryFixed(),"2025",t)}onPrimaryFixedVariant(){let t=u.fromPalette({name:"on_primary_fixed_variant",palette:e=>e.primaryPalette,background:e=>this.primaryFixedDim(),contrastCurve:e=>b(4.5)});return w(super.onPrimaryFixedVariant(),"2025",t)}inversePrimary(){let t=u.fromPalette({name:"inverse_primary",palette:e=>e.primaryPalette,tone:e=>M(e.primaryPalette),background:e=>this.inverseSurface(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.inversePrimary(),"2025",t)}secondary(){let t=u.fromPalette({name:"secondary",palette:e=>e.secondaryPalette,tone:e=>e.platform==="watch"?e.variant===s.NEUTRAL?90:M(e.secondaryPalette,0,90):e.variant===s.NEUTRAL?e.isDark?ot(e.secondaryPalette,0,98):M(e.secondaryPalette):e.variant===s.VIBRANT?M(e.secondaryPalette,0,e.isDark?90:98):e.isDark?80:M(e.secondaryPalette),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?b(4.5):b(7),toneDeltaPair:e=>e.platform==="phone"?new B(this.secondaryContainer(),this.secondary(),5,"relative_lighter",!0,"farther"):void 0});return w(super.secondary(),"2025",t)}secondaryDim(){return u.fromPalette({name:"secondary_dim",palette:t=>t.secondaryPalette,tone:t=>t.variant===s.NEUTRAL?85:M(t.secondaryPalette,0,90),isBackground:!0,background:t=>this.surfaceContainerHigh(),contrastCurve:t=>b(4.5),toneDeltaPair:t=>new B(this.secondaryDim(),this.secondary(),5,"darker",!0,"farther")})}onSecondary(){let t=u.fromPalette({name:"on_secondary",palette:e=>e.secondaryPalette,background:e=>e.platform==="phone"?this.secondary():this.secondaryDim(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onSecondary(),"2025",t)}secondaryContainer(){let t=u.fromPalette({name:"secondary_container",palette:e=>e.secondaryPalette,tone:e=>e.platform==="watch"?30:e.variant===s.VIBRANT?e.isDark?ot(e.secondaryPalette,30,40):M(e.secondaryPalette,84,90):e.variant===s.EXPRESSIVE?e.isDark?15:M(e.secondaryPalette,90,95):e.isDark?25:90,isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,toneDeltaPair:e=>e.platform==="watch"?new B(this.secondaryContainer(),this.secondaryDim(),10,"darker",!0,"farther"):void 0,contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.secondaryContainer(),"2025",t)}onSecondaryContainer(){let t=u.fromPalette({name:"on_secondary_container",palette:e=>e.secondaryPalette,background:e=>this.secondaryContainer(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onSecondaryContainer(),"2025",t)}secondaryFixed(){let t=u.fromPalette({name:"secondary_fixed",palette:e=>e.secondaryPalette,tone:e=>{let n=Object.assign({},e,{isDark:!1,contrastLevel:0});return this.secondaryContainer().getTone(n)},isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.secondaryFixed(),"2025",t)}secondaryFixedDim(){let t=u.fromPalette({name:"secondary_fixed_dim",palette:e=>e.secondaryPalette,tone:e=>this.secondaryFixed().getTone(e),isBackground:!0,toneDeltaPair:e=>new B(this.secondaryFixedDim(),this.secondaryFixed(),5,"darker",!0,"exact")});return w(super.secondaryFixedDim(),"2025",t)}onSecondaryFixed(){let t=u.fromPalette({name:"on_secondary_fixed",palette:e=>e.secondaryPalette,background:e=>this.secondaryFixedDim(),contrastCurve:e=>b(7)});return w(super.onSecondaryFixed(),"2025",t)}onSecondaryFixedVariant(){let t=u.fromPalette({name:"on_secondary_fixed_variant",palette:e=>e.secondaryPalette,background:e=>this.secondaryFixedDim(),contrastCurve:e=>b(4.5)});return w(super.onSecondaryFixedVariant(),"2025",t)}tertiary(){let t=u.fromPalette({name:"tertiary",palette:e=>e.tertiaryPalette,tone:e=>e.platform==="watch"?e.variant===s.TONAL_SPOT?M(e.tertiaryPalette,0,90):M(e.tertiaryPalette):e.variant===s.EXPRESSIVE||e.variant===s.VIBRANT?M(e.tertiaryPalette,0,T.isCyan(e.tertiaryPalette.hue)?88:e.isDark?98:100):e.isDark?M(e.tertiaryPalette,0,98):M(e.tertiaryPalette),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?b(4.5):b(7),toneDeltaPair:e=>e.platform==="phone"?new B(this.tertiaryContainer(),this.tertiary(),5,"relative_lighter",!0,"farther"):void 0});return w(super.tertiary(),"2025",t)}tertiaryDim(){return u.fromPalette({name:"tertiary_dim",palette:t=>t.tertiaryPalette,tone:t=>t.variant===s.TONAL_SPOT?M(t.tertiaryPalette,0,90):M(t.tertiaryPalette),isBackground:!0,background:t=>this.surfaceContainerHigh(),contrastCurve:t=>b(4.5),toneDeltaPair:t=>new B(this.tertiaryDim(),this.tertiary(),5,"darker",!0,"farther")})}onTertiary(){let t=u.fromPalette({name:"on_tertiary",palette:e=>e.tertiaryPalette,background:e=>e.platform==="phone"?this.tertiary():this.tertiaryDim(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onTertiary(),"2025",t)}tertiaryContainer(){let t=u.fromPalette({name:"tertiary_container",palette:e=>e.tertiaryPalette,tone:e=>e.platform==="watch"?e.variant===s.TONAL_SPOT?M(e.tertiaryPalette,0,90):M(e.tertiaryPalette):e.variant===s.NEUTRAL?e.isDark?M(e.tertiaryPalette,0,93):M(e.tertiaryPalette,0,96):e.variant===s.TONAL_SPOT?M(e.tertiaryPalette,0,e.isDark?93:100):e.variant===s.EXPRESSIVE?M(e.tertiaryPalette,75,T.isCyan(e.tertiaryPalette.hue)?88:e.isDark?93:100):e.isDark?M(e.tertiaryPalette,0,93):M(e.tertiaryPalette,72,100),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,toneDeltaPair:e=>e.platform==="watch"?new B(this.tertiaryContainer(),this.tertiaryDim(),10,"darker",!0,"farther"):void 0,contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.tertiaryContainer(),"2025",t)}onTertiaryContainer(){let t=u.fromPalette({name:"on_tertiary_container",palette:e=>e.tertiaryPalette,background:e=>this.tertiaryContainer(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onTertiaryContainer(),"2025",t)}tertiaryFixed(){let t=u.fromPalette({name:"tertiary_fixed",palette:e=>e.tertiaryPalette,tone:e=>{let n=Object.assign({},e,{isDark:!1,contrastLevel:0});return this.tertiaryContainer().getTone(n)},isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.tertiaryFixed(),"2025",t)}tertiaryFixedDim(){let t=u.fromPalette({name:"tertiary_fixed_dim",palette:e=>e.tertiaryPalette,tone:e=>this.tertiaryFixed().getTone(e),isBackground:!0,toneDeltaPair:e=>new B(this.tertiaryFixedDim(),this.tertiaryFixed(),5,"darker",!0,"exact")});return w(super.tertiaryFixedDim(),"2025",t)}onTertiaryFixed(){let t=u.fromPalette({name:"on_tertiary_fixed",palette:e=>e.tertiaryPalette,background:e=>this.tertiaryFixedDim(),contrastCurve:e=>b(7)});return w(super.onTertiaryFixed(),"2025",t)}onTertiaryFixedVariant(){let t=u.fromPalette({name:"on_tertiary_fixed_variant",palette:e=>e.tertiaryPalette,background:e=>this.tertiaryFixedDim(),contrastCurve:e=>b(4.5)});return w(super.onTertiaryFixedVariant(),"2025",t)}error(){let t=u.fromPalette({name:"error",palette:e=>e.errorPalette,tone:e=>e.platform==="phone"?e.isDark?ot(e.errorPalette,0,98):M(e.errorPalette):ot(e.errorPalette),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):this.surfaceContainerHigh(),contrastCurve:e=>e.platform==="phone"?b(4.5):b(7),toneDeltaPair:e=>e.platform==="phone"?new B(this.errorContainer(),this.error(),5,"relative_lighter",!0,"farther"):void 0});return w(super.error(),"2025",t)}errorDim(){return u.fromPalette({name:"error_dim",palette:t=>t.errorPalette,tone:t=>ot(t.errorPalette),isBackground:!0,background:t=>this.surfaceContainerHigh(),contrastCurve:t=>b(4.5),toneDeltaPair:t=>new B(this.errorDim(),this.error(),5,"darker",!0,"farther")})}onError(){let t=u.fromPalette({name:"on_error",palette:e=>e.errorPalette,background:e=>e.platform==="phone"?this.error():this.errorDim(),contrastCurve:e=>e.platform==="phone"?b(6):b(7)});return w(super.onError(),"2025",t)}errorContainer(){let t=u.fromPalette({name:"error_container",palette:e=>e.errorPalette,tone:e=>e.platform==="watch"?30:e.isDark?ot(e.errorPalette,30,93):M(e.errorPalette,0,90),isBackground:!0,background:e=>e.platform==="phone"?this.highestSurface(e):void 0,toneDeltaPair:e=>e.platform==="watch"?new B(this.errorContainer(),this.errorDim(),10,"darker",!0,"farther"):void 0,contrastCurve:e=>e.platform==="phone"&&e.contrastLevel>0?b(1.5):void 0});return w(super.errorContainer(),"2025",t)}onErrorContainer(){let t=u.fromPalette({name:"on_error_container",palette:e=>e.errorPalette,background:e=>this.errorContainer(),contrastCurve:e=>e.platform==="phone"?b(4.5):b(7)});return w(super.onErrorContainer(),"2025",t)}surfaceVariant(){let t=Object.assign(this.surfaceContainerHighest().clone(),{name:"surface_variant"});return w(super.surfaceVariant(),"2025",t)}surfaceTint(){let t=Object.assign(this.primary().clone(),{name:"surface_tint"});return w(super.surfaceTint(),"2025",t)}background(){let t=Object.assign(this.surface().clone(),{name:"background"});return w(super.background(),"2025",t)}onBackground(){let t=Object.assign(this.onSurface().clone(),{name:"on_background",tone:e=>e.platform==="watch"?100:this.onSurface().getTone(e)});return w(super.onBackground(),"2025",t)}};var h=class r{constructor(){this.allColors=[this.background(),this.onBackground(),this.surface(),this.surfaceDim(),this.surfaceBright(),this.surfaceContainerLowest(),this.surfaceContainerLow(),this.surfaceContainer(),this.surfaceContainerHigh(),this.surfaceContainerHighest(),this.onSurface(),this.onSurfaceVariant(),this.outline(),this.outlineVariant(),this.inverseSurface(),this.inverseOnSurface(),this.primary(),this.primaryDim(),this.onPrimary(),this.primaryContainer(),this.onPrimaryContainer(),this.primaryFixed(),this.primaryFixedDim(),this.onPrimaryFixed(),this.onPrimaryFixedVariant(),this.inversePrimary(),this.secondary(),this.secondaryDim(),this.onSecondary(),this.secondaryContainer(),this.onSecondaryContainer(),this.secondaryFixed(),this.secondaryFixedDim(),this.onSecondaryFixed(),this.onSecondaryFixedVariant(),this.tertiary(),this.tertiaryDim(),this.onTertiary(),this.tertiaryContainer(),this.onTertiaryContainer(),this.tertiaryFixed(),this.tertiaryFixedDim(),this.onTertiaryFixed(),this.onTertiaryFixedVariant(),this.error(),this.errorDim(),this.onError(),this.errorContainer(),this.onErrorContainer()].filter(t=>t!==void 0)}highestSurface(t){return r.colorSpec.highestSurface(t)}primaryPaletteKeyColor(){return r.colorSpec.primaryPaletteKeyColor()}secondaryPaletteKeyColor(){return r.colorSpec.secondaryPaletteKeyColor()}tertiaryPaletteKeyColor(){return r.colorSpec.tertiaryPaletteKeyColor()}neutralPaletteKeyColor(){return r.colorSpec.neutralPaletteKeyColor()}neutralVariantPaletteKeyColor(){return r.colorSpec.neutralVariantPaletteKeyColor()}errorPaletteKeyColor(){return r.colorSpec.errorPaletteKeyColor()}background(){return r.colorSpec.background()}onBackground(){return r.colorSpec.onBackground()}surface(){return r.colorSpec.surface()}surfaceDim(){return r.colorSpec.surfaceDim()}surfaceBright(){return r.colorSpec.surfaceBright()}surfaceContainerLowest(){return r.colorSpec.surfaceContainerLowest()}surfaceContainerLow(){return r.colorSpec.surfaceContainerLow()}surfaceContainer(){return r.colorSpec.surfaceContainer()}surfaceContainerHigh(){return r.colorSpec.surfaceContainerHigh()}surfaceContainerHighest(){return r.colorSpec.surfaceContainerHighest()}onSurface(){return r.colorSpec.onSurface()}surfaceVariant(){return r.colorSpec.surfaceVariant()}onSurfaceVariant(){return r.colorSpec.onSurfaceVariant()}outline(){return r.colorSpec.outline()}outlineVariant(){return r.colorSpec.outlineVariant()}inverseSurface(){return r.colorSpec.inverseSurface()}inverseOnSurface(){return r.colorSpec.inverseOnSurface()}shadow(){return r.colorSpec.shadow()}scrim(){return r.colorSpec.scrim()}surfaceTint(){return r.colorSpec.surfaceTint()}primary(){return r.colorSpec.primary()}primaryDim(){return r.colorSpec.primaryDim()}onPrimary(){return r.colorSpec.onPrimary()}primaryContainer(){return r.colorSpec.primaryContainer()}onPrimaryContainer(){return r.colorSpec.onPrimaryContainer()}inversePrimary(){return r.colorSpec.inversePrimary()}primaryFixed(){return r.colorSpec.primaryFixed()}primaryFixedDim(){return r.colorSpec.primaryFixedDim()}onPrimaryFixed(){return r.colorSpec.onPrimaryFixed()}onPrimaryFixedVariant(){return r.colorSpec.onPrimaryFixedVariant()}secondary(){return r.colorSpec.secondary()}secondaryDim(){return r.colorSpec.secondaryDim()}onSecondary(){return r.colorSpec.onSecondary()}secondaryContainer(){return r.colorSpec.secondaryContainer()}onSecondaryContainer(){return r.colorSpec.onSecondaryContainer()}secondaryFixed(){return r.colorSpec.secondaryFixed()}secondaryFixedDim(){return r.colorSpec.secondaryFixedDim()}onSecondaryFixed(){return r.colorSpec.onSecondaryFixed()}onSecondaryFixedVariant(){return r.colorSpec.onSecondaryFixedVariant()}tertiary(){return r.colorSpec.tertiary()}tertiaryDim(){return r.colorSpec.tertiaryDim()}onTertiary(){return r.colorSpec.onTertiary()}tertiaryContainer(){return r.colorSpec.tertiaryContainer()}onTertiaryContainer(){return r.colorSpec.onTertiaryContainer()}tertiaryFixed(){return r.colorSpec.tertiaryFixed()}tertiaryFixedDim(){return r.colorSpec.tertiaryFixedDim()}onTertiaryFixed(){return r.colorSpec.onTertiaryFixed()}onTertiaryFixedVariant(){return r.colorSpec.onTertiaryFixedVariant()}error(){return r.colorSpec.error()}errorDim(){return r.colorSpec.errorDim()}onError(){return r.colorSpec.onError()}errorContainer(){return r.colorSpec.errorContainer()}onErrorContainer(){return r.colorSpec.onErrorContainer()}static highestSurface(t){return r.colorSpec.highestSurface(t)}};h.contentAccentToneDelta=15;h.colorSpec=new Et;h.primaryPaletteKeyColor=h.colorSpec.primaryPaletteKeyColor();h.secondaryPaletteKeyColor=h.colorSpec.secondaryPaletteKeyColor();h.tertiaryPaletteKeyColor=h.colorSpec.tertiaryPaletteKeyColor();h.neutralPaletteKeyColor=h.colorSpec.neutralPaletteKeyColor();h.neutralVariantPaletteKeyColor=h.colorSpec.neutralVariantPaletteKeyColor();h.background=h.colorSpec.background();h.onBackground=h.colorSpec.onBackground();h.surface=h.colorSpec.surface();h.surfaceDim=h.colorSpec.surfaceDim();h.surfaceBright=h.colorSpec.surfaceBright();h.surfaceContainerLowest=h.colorSpec.surfaceContainerLowest();h.surfaceContainerLow=h.colorSpec.surfaceContainerLow();h.surfaceContainer=h.colorSpec.surfaceContainer();h.surfaceContainerHigh=h.colorSpec.surfaceContainerHigh();h.surfaceContainerHighest=h.colorSpec.surfaceContainerHighest();h.onSurface=h.colorSpec.onSurface();h.surfaceVariant=h.colorSpec.surfaceVariant();h.onSurfaceVariant=h.colorSpec.onSurfaceVariant();h.inverseSurface=h.colorSpec.inverseSurface();h.inverseOnSurface=h.colorSpec.inverseOnSurface();h.outline=h.colorSpec.outline();h.outlineVariant=h.colorSpec.outlineVariant();h.shadow=h.colorSpec.shadow();h.scrim=h.colorSpec.scrim();h.surfaceTint=h.colorSpec.surfaceTint();h.primary=h.colorSpec.primary();h.onPrimary=h.colorSpec.onPrimary();h.primaryContainer=h.colorSpec.primaryContainer();h.onPrimaryContainer=h.colorSpec.onPrimaryContainer();h.inversePrimary=h.colorSpec.inversePrimary();h.secondary=h.colorSpec.secondary();h.onSecondary=h.colorSpec.onSecondary();h.secondaryContainer=h.colorSpec.secondaryContainer();h.onSecondaryContainer=h.colorSpec.onSecondaryContainer();h.tertiary=h.colorSpec.tertiary();h.onTertiary=h.colorSpec.onTertiary();h.tertiaryContainer=h.colorSpec.tertiaryContainer();h.onTertiaryContainer=h.colorSpec.onTertiaryContainer();h.error=h.colorSpec.error();h.onError=h.colorSpec.onError();h.errorContainer=h.colorSpec.errorContainer();h.onErrorContainer=h.colorSpec.onErrorContainer();h.primaryFixed=h.colorSpec.primaryFixed();h.primaryFixedDim=h.colorSpec.primaryFixedDim();h.onPrimaryFixed=h.colorSpec.onPrimaryFixed();h.onPrimaryFixedVariant=h.colorSpec.onPrimaryFixedVariant();h.secondaryFixed=h.colorSpec.secondaryFixed();h.secondaryFixedDim=h.colorSpec.secondaryFixedDim();h.onSecondaryFixed=h.colorSpec.onSecondaryFixed();h.onSecondaryFixedVariant=h.colorSpec.onSecondaryFixedVariant();h.tertiaryFixed=h.colorSpec.tertiaryFixed();h.tertiaryFixedDim=h.colorSpec.tertiaryFixedDim();h.onTertiaryFixed=h.colorSpec.onTertiaryFixed();h.onTertiaryFixedVariant=h.colorSpec.onTertiaryFixedVariant();var F=class r{static maybeFallbackSpecVersion(t,e){switch(e){case s.EXPRESSIVE:case s.VIBRANT:case s.TONAL_SPOT:case s.NEUTRAL:return t;default:return"2021"}}constructor(t){this.sourceColorArgb=t.sourceColorHct.toInt(),this.variant=t.variant,this.contrastLevel=t.contrastLevel,this.isDark=t.isDark,this.platform=t.platform??"phone",this.specVersion=r.maybeFallbackSpecVersion(t.specVersion??"2021",this.variant),this.sourceColorHct=t.sourceColorHct,this.primaryPalette=t.primaryPalette??gt(this.specVersion).getPrimaryPalette(this.variant,t.sourceColorHct,this.isDark,this.platform,this.contrastLevel),this.secondaryPalette=t.secondaryPalette??gt(this.specVersion).getSecondaryPalette(this.variant,t.sourceColorHct,this.isDark,this.platform,this.contrastLevel),this.tertiaryPalette=t.tertiaryPalette??gt(this.specVersion).getTertiaryPalette(this.variant,t.sourceColorHct,this.isDark,this.platform,this.contrastLevel),this.neutralPalette=t.neutralPalette??gt(this.specVersion).getNeutralPalette(this.variant,t.sourceColorHct,this.isDark,this.platform,this.contrastLevel),this.neutralVariantPalette=t.neutralVariantPalette??gt(this.specVersion).getNeutralVariantPalette(this.variant,t.sourceColorHct,this.isDark,this.platform,this.contrastLevel),this.errorPalette=t.errorPalette??gt(this.specVersion).getErrorPalette(this.variant,t.sourceColorHct,this.isDark,this.platform,this.contrastLevel)??x.fromHueAndChroma(25,84),this.colors=new h}toString(){return`Scheme: variant=${s[this.variant]}, mode=${this.isDark?"dark":"light"}, platform=${this.platform}, contrastLevel=${this.contrastLevel.toFixed(1)}, seed=${this.sourceColorHct.toString()}, specVersion=${this.specVersion}`}static getPiecewiseHue(t,e,n){let a=Math.min(e.length-1,n.length),o=t.hue;for(let i=0;i<a;i++)if(o>=e[i]&&o<e[i+1])return z(n[i]);return o}static getRotatedHue(t,e,n){let a=r.getPiecewiseHue(t,e,n);return Math.min(e.length-1,n.length)<=0&&(a=0),z(t.hue+a)}getArgb(t){return t.getArgb(this)}getHct(t){return t.getHct(this)}get primaryPaletteKeyColor(){return this.getArgb(this.colors.primaryPaletteKeyColor())}get secondaryPaletteKeyColor(){return this.getArgb(this.colors.secondaryPaletteKeyColor())}get tertiaryPaletteKeyColor(){return this.getArgb(this.colors.tertiaryPaletteKeyColor())}get neutralPaletteKeyColor(){return this.getArgb(this.colors.neutralPaletteKeyColor())}get neutralVariantPaletteKeyColor(){return this.getArgb(this.colors.neutralVariantPaletteKeyColor())}get errorPaletteKeyColor(){return this.getArgb(this.colors.errorPaletteKeyColor())}get background(){return this.getArgb(this.colors.background())}get onBackground(){return this.getArgb(this.colors.onBackground())}get surface(){return this.getArgb(this.colors.surface())}get surfaceDim(){return this.getArgb(this.colors.surfaceDim())}get surfaceBright(){return this.getArgb(this.colors.surfaceBright())}get surfaceContainerLowest(){return this.getArgb(this.colors.surfaceContainerLowest())}get surfaceContainerLow(){return this.getArgb(this.colors.surfaceContainerLow())}get surfaceContainer(){return this.getArgb(this.colors.surfaceContainer())}get surfaceContainerHigh(){return this.getArgb(this.colors.surfaceContainerHigh())}get surfaceContainerHighest(){return this.getArgb(this.colors.surfaceContainerHighest())}get onSurface(){return this.getArgb(this.colors.onSurface())}get surfaceVariant(){return this.getArgb(this.colors.surfaceVariant())}get onSurfaceVariant(){return this.getArgb(this.colors.onSurfaceVariant())}get inverseSurface(){return this.getArgb(this.colors.inverseSurface())}get inverseOnSurface(){return this.getArgb(this.colors.inverseOnSurface())}get outline(){return this.getArgb(this.colors.outline())}get outlineVariant(){return this.getArgb(this.colors.outlineVariant())}get shadow(){return this.getArgb(this.colors.shadow())}get scrim(){return this.getArgb(this.colors.scrim())}get surfaceTint(){return this.getArgb(this.colors.surfaceTint())}get primary(){return this.getArgb(this.colors.primary())}get primaryDim(){let t=this.colors.primaryDim();if(t===void 0)throw new Error("`primaryDim` color is undefined prior to 2025 spec.");return this.getArgb(t)}get onPrimary(){return this.getArgb(this.colors.onPrimary())}get primaryContainer(){return this.getArgb(this.colors.primaryContainer())}get onPrimaryContainer(){return this.getArgb(this.colors.onPrimaryContainer())}get primaryFixed(){return this.getArgb(this.colors.primaryFixed())}get primaryFixedDim(){return this.getArgb(this.colors.primaryFixedDim())}get onPrimaryFixed(){return this.getArgb(this.colors.onPrimaryFixed())}get onPrimaryFixedVariant(){return this.getArgb(this.colors.onPrimaryFixedVariant())}get inversePrimary(){return this.getArgb(this.colors.inversePrimary())}get secondary(){return this.getArgb(this.colors.secondary())}get secondaryDim(){let t=this.colors.secondaryDim();if(t===void 0)throw new Error("`secondaryDim` color is undefined prior to 2025 spec.");return this.getArgb(t)}get onSecondary(){return this.getArgb(this.colors.onSecondary())}get secondaryContainer(){return this.getArgb(this.colors.secondaryContainer())}get onSecondaryContainer(){return this.getArgb(this.colors.onSecondaryContainer())}get secondaryFixed(){return this.getArgb(this.colors.secondaryFixed())}get secondaryFixedDim(){return this.getArgb(this.colors.secondaryFixedDim())}get onSecondaryFixed(){return this.getArgb(this.colors.onSecondaryFixed())}get onSecondaryFixedVariant(){return this.getArgb(this.colors.onSecondaryFixedVariant())}get tertiary(){return this.getArgb(this.colors.tertiary())}get tertiaryDim(){let t=this.colors.tertiaryDim();if(t===void 0)throw new Error("`tertiaryDim` color is undefined prior to 2025 spec.");return this.getArgb(t)}get onTertiary(){return this.getArgb(this.colors.onTertiary())}get tertiaryContainer(){return this.getArgb(this.colors.tertiaryContainer())}get onTertiaryContainer(){return this.getArgb(this.colors.onTertiaryContainer())}get tertiaryFixed(){return this.getArgb(this.colors.tertiaryFixed())}get tertiaryFixedDim(){return this.getArgb(this.colors.tertiaryFixedDim())}get onTertiaryFixed(){return this.getArgb(this.colors.onTertiaryFixed())}get onTertiaryFixedVariant(){return this.getArgb(this.colors.onTertiaryFixedVariant())}get error(){return this.getArgb(this.colors.error())}get errorDim(){let t=this.colors.errorDim();if(t===void 0)throw new Error("`errorDim` color is undefined prior to 2025 spec.");return this.getArgb(t)}get onError(){return this.getArgb(this.colors.onError())}get errorContainer(){return this.getArgb(this.colors.errorContainer())}get onErrorContainer(){return this.getArgb(this.colors.onErrorContainer())}};F.DEFAULT_SPEC_VERSION="2021";F.DEFAULT_PLATFORM="phone";var It=class{getPrimaryPalette(t,e,n,a,o){switch(t){case s.CONTENT:case s.FIDELITY:return x.fromHueAndChroma(e.hue,e.chroma);case s.FRUIT_SALAD:return x.fromHueAndChroma(z(e.hue-50),48);case s.MONOCHROME:return x.fromHueAndChroma(e.hue,0);case s.NEUTRAL:return x.fromHueAndChroma(e.hue,12);case s.RAINBOW:return x.fromHueAndChroma(e.hue,48);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,36);case s.EXPRESSIVE:return x.fromHueAndChroma(z(e.hue+240),40);case s.VIBRANT:return x.fromHueAndChroma(e.hue,200);default:throw new Error(`Unsupported variant: ${t}`)}}getSecondaryPalette(t,e,n,a,o){switch(t){case s.CONTENT:case s.FIDELITY:return x.fromHueAndChroma(e.hue,Math.max(e.chroma-32,e.chroma*.5));case s.FRUIT_SALAD:return x.fromHueAndChroma(z(e.hue-50),36);case s.MONOCHROME:return x.fromHueAndChroma(e.hue,0);case s.NEUTRAL:return x.fromHueAndChroma(e.hue,8);case s.RAINBOW:return x.fromHueAndChroma(e.hue,16);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,16);case s.EXPRESSIVE:return x.fromHueAndChroma(F.getRotatedHue(e,[0,21,51,121,151,191,271,321,360],[45,95,45,20,45,90,45,45,45]),24);case s.VIBRANT:return x.fromHueAndChroma(F.getRotatedHue(e,[0,41,61,101,131,181,251,301,360],[18,15,10,12,15,18,15,12,12]),24);default:throw new Error(`Unsupported variant: ${t}`)}}getTertiaryPalette(t,e,n,a,o){switch(t){case s.CONTENT:return x.fromHct(ut.fixIfDisliked(new St(e).analogous(3,6)[2]));case s.FIDELITY:return x.fromHct(ut.fixIfDisliked(new St(e).complement));case s.FRUIT_SALAD:return x.fromHueAndChroma(e.hue,36);case s.MONOCHROME:return x.fromHueAndChroma(e.hue,0);case s.NEUTRAL:return x.fromHueAndChroma(e.hue,16);case s.RAINBOW:case s.TONAL_SPOT:return x.fromHueAndChroma(z(e.hue+60),24);case s.EXPRESSIVE:return x.fromHueAndChroma(F.getRotatedHue(e,[0,21,51,121,151,191,271,321,360],[120,120,20,45,20,15,20,120,120]),32);case s.VIBRANT:return x.fromHueAndChroma(F.getRotatedHue(e,[0,41,61,101,131,181,251,301,360],[35,30,20,25,30,35,30,25,25]),32);default:throw new Error(`Unsupported variant: ${t}`)}}getNeutralPalette(t,e,n,a,o){switch(t){case s.CONTENT:case s.FIDELITY:return x.fromHueAndChroma(e.hue,e.chroma/8);case s.FRUIT_SALAD:return x.fromHueAndChroma(e.hue,10);case s.MONOCHROME:return x.fromHueAndChroma(e.hue,0);case s.NEUTRAL:return x.fromHueAndChroma(e.hue,2);case s.RAINBOW:return x.fromHueAndChroma(e.hue,0);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,6);case s.EXPRESSIVE:return x.fromHueAndChroma(z(e.hue+15),8);case s.VIBRANT:return x.fromHueAndChroma(e.hue,10);default:throw new Error(`Unsupported variant: ${t}`)}}getNeutralVariantPalette(t,e,n,a,o){switch(t){case s.CONTENT:return x.fromHueAndChroma(e.hue,e.chroma/8+4);case s.FIDELITY:return x.fromHueAndChroma(e.hue,e.chroma/8+4);case s.FRUIT_SALAD:return x.fromHueAndChroma(e.hue,16);case s.MONOCHROME:return x.fromHueAndChroma(e.hue,0);case s.NEUTRAL:return x.fromHueAndChroma(e.hue,2);case s.RAINBOW:return x.fromHueAndChroma(e.hue,0);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,8);case s.EXPRESSIVE:return x.fromHueAndChroma(z(e.hue+15),12);case s.VIBRANT:return x.fromHueAndChroma(e.hue,12);default:throw new Error(`Unsupported variant: ${t}`)}}getErrorPalette(t,e,n,a,o){}},ae=class r extends It{getPrimaryPalette(t,e,n,a,o){switch(t){case s.NEUTRAL:return x.fromHueAndChroma(e.hue,a==="phone"?T.isBlue(e.hue)?12:8:T.isBlue(e.hue)?16:12);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,a==="phone"&&n?26:32);case s.EXPRESSIVE:return x.fromHueAndChroma(e.hue,a==="phone"?n?36:48:40);case s.VIBRANT:return x.fromHueAndChroma(e.hue,a==="phone"?74:56);default:return super.getPrimaryPalette(t,e,n,a,o)}}getSecondaryPalette(t,e,n,a,o){switch(t){case s.NEUTRAL:return x.fromHueAndChroma(e.hue,a==="phone"?T.isBlue(e.hue)?6:4:T.isBlue(e.hue)?10:6);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,16);case s.EXPRESSIVE:return x.fromHueAndChroma(F.getRotatedHue(e,[0,105,140,204,253,278,300,333,360],[-160,155,-100,96,-96,-156,-165,-160]),a==="phone"&&n?16:24);case s.VIBRANT:return x.fromHueAndChroma(F.getRotatedHue(e,[0,38,105,140,333,360],[-14,10,-14,10,-14]),a==="phone"?56:36);default:return super.getSecondaryPalette(t,e,n,a,o)}}getTertiaryPalette(t,e,n,a,o){switch(t){case s.NEUTRAL:return x.fromHueAndChroma(F.getRotatedHue(e,[0,38,105,161,204,278,333,360],[-32,26,10,-39,24,-15,-32]),a==="phone"?20:36);case s.TONAL_SPOT:return x.fromHueAndChroma(F.getRotatedHue(e,[0,20,71,161,333,360],[-40,48,-32,40,-32]),a==="phone"?28:32);case s.EXPRESSIVE:return x.fromHueAndChroma(F.getRotatedHue(e,[0,105,140,204,253,278,300,333,360],[-165,160,-105,101,-101,-160,-170,-165]),48);case s.VIBRANT:return x.fromHueAndChroma(F.getRotatedHue(e,[0,38,71,105,140,161,253,333,360],[-72,35,24,-24,62,50,62,-72]),56);default:return super.getTertiaryPalette(t,e,n,a,o)}}static getExpressiveNeutralHue(t){return F.getRotatedHue(t,[0,71,124,253,278,300,360],[10,0,10,0,10,0])}static getExpressiveNeutralChroma(t,e,n){let a=r.getExpressiveNeutralHue(t);return n==="phone"?e?T.isYellow(a)?6:14:18:12}static getVibrantNeutralHue(t){return F.getRotatedHue(t,[0,38,105,140,333,360],[-14,10,-14,10,-14])}static getVibrantNeutralChroma(t,e){let n=r.getVibrantNeutralHue(t);return e==="phone"||T.isBlue(n)?28:20}getNeutralPalette(t,e,n,a,o){switch(t){case s.NEUTRAL:return x.fromHueAndChroma(e.hue,a==="phone"?1.4:6);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,a==="phone"?5:10);case s.EXPRESSIVE:return x.fromHueAndChroma(r.getExpressiveNeutralHue(e),r.getExpressiveNeutralChroma(e,n,a));case s.VIBRANT:return x.fromHueAndChroma(r.getVibrantNeutralHue(e),r.getVibrantNeutralChroma(e,a));default:return super.getNeutralPalette(t,e,n,a,o)}}getNeutralVariantPalette(t,e,n,a,o){switch(t){case s.NEUTRAL:return x.fromHueAndChroma(e.hue,(a==="phone"?1.4:6)*2.2);case s.TONAL_SPOT:return x.fromHueAndChroma(e.hue,(a==="phone"?5:10)*1.7);case s.EXPRESSIVE:let i=r.getExpressiveNeutralHue(e),c=r.getExpressiveNeutralChroma(e,n,a);return x.fromHueAndChroma(i,c*(i>=105&&i<125?1.6:2.3));case s.VIBRANT:let f=r.getVibrantNeutralHue(e),g=r.getVibrantNeutralChroma(e,a);return x.fromHueAndChroma(f,g*1.29);default:return super.getNeutralVariantPalette(t,e,n,a,o)}}getErrorPalette(t,e,n,a,o){let i=F.getPiecewiseHue(e,[0,3,13,23,33,43,153,273,360],[12,22,32,12,22,32,22,12]);switch(t){case s.NEUTRAL:return x.fromHueAndChroma(i,a==="phone"?50:40);case s.TONAL_SPOT:return x.fromHueAndChroma(i,a==="phone"?60:48);case s.EXPRESSIVE:return x.fromHueAndChroma(i,a==="phone"?64:48);case s.VIBRANT:return x.fromHueAndChroma(i,a==="phone"?80:60);default:return super.getErrorPalette(t,e,n,a,o)}}},He=new It,Ue=new ae;function gt(r){return r==="2025"?Ue:He}var Mt=class{fromInt(t){return Ft(t)}toInt(t){return ge(t[0],t[1],t[2])}distance(t,e){let n=t[0]-e[0],a=t[1]-e[1],o=t[2]-e[2];return n*n+a*a+o*o}};var _e=10,ze=3,Bt=class{static quantize(t,e,n){let a=new Map,o=new Array,i=new Array,c=new Mt,f=0;for(let S=0;S<t.length;S++){let k=t[S],I=a.get(k);I===void 0?(f++,o.push(c.fromInt(k)),i.push(k),a.set(k,1)):a.set(k,I+1)}let g=new Array;for(let S=0;S<f;S++){let k=i[S],I=a.get(k);I!==void 0&&(g[S]=I)}let m=Math.min(n,f);e.length>0&&(m=Math.min(m,e.length));let y=new Array;for(let S=0;S<e.length;S++)y.push(c.fromInt(e[S]));let P=m-y.length;if(e.length===0&&P>0)for(let S=0;S<P;S++){let k=Math.random()*100,I=Math.random()*201+-100,L=Math.random()*201+-100;y.push(new Array(k,I,L))}let d=new Array;for(let S=0;S<f;S++)d.push(Math.floor(Math.random()*m));let p=new Array;for(let S=0;S<m;S++){p.push(new Array);for(let k=0;k<m;k++)p[S].push(0)}let l=new Array;for(let S=0;S<m;S++){l.push(new Array);for(let k=0;k<m;k++)l[S].push(new oe)}let C=new Array;for(let S=0;S<m;S++)C.push(0);for(let S=0;S<_e;S++){for(let A=0;A<m;A++){for(let E=A+1;E<m;E++){let V=c.distance(y[A],y[E]);l[E][A].distance=V,l[E][A].index=A,l[A][E].distance=V,l[A][E].index=E}l[A].sort();for(let E=0;E<m;E++)p[A][E]=l[A][E].index}let k=0;for(let A=0;A<f;A++){let E=o[A],V=d[A],R=y[V],Y=c.distance(E,R),q=Y,tt=-1;for(let _=0;_<m;_++){if(l[V][_].distance>=4*Y)continue;let it=c.distance(E,y[_]);it<q&&(q=it,tt=_)}tt!==-1&&Math.abs(Math.sqrt(q)-Math.sqrt(Y))>ze&&(k++,d[A]=tt)}if(k===0&&S!==0)break;let I=new Array(m).fill(0),L=new Array(m).fill(0),O=new Array(m).fill(0);for(let A=0;A<m;A++)C[A]=0;for(let A=0;A<f;A++){let E=d[A],V=o[A],R=g[A];C[E]+=R,I[E]+=V[0]*R,L[E]+=V[1]*R,O[E]+=V[2]*R}for(let A=0;A<m;A++){let E=C[A];if(E===0){y[A]=[0,0,0];continue}let V=I[A]/E,R=L[A]/E,Y=O[A]/E;y[A]=[V,R,Y]}}let v=new Map;for(let S=0;S<m;S++){let k=C[S];if(k===0)continue;let I=c.toInt(y[S]);v.has(I)||v.set(I,k)}return v}},oe=class{constructor(){this.distance=-1,this.index=-1}};var Rt=class{static quantize(t){let e=new Map;for(let n=0;n<t.length;n++){let a=t[n];de(a)<255||e.set(a,(e.get(a)??0)+1)}return e}};var Lt=5,Z=33,xt=35937,K={RED:"red",GREEN:"green",BLUE:"blue"},Ot=class{constructor(t=[],e=[],n=[],a=[],o=[],i=[]){this.weights=t,this.momentsR=e,this.momentsG=n,this.momentsB=a,this.moments=o,this.cubes=i}quantize(t,e){this.constructHistogram(t),this.computeMoments();let n=this.createBoxes(e);return this.createResult(n.resultCount)}constructHistogram(t){this.weights=Array.from({length:xt}).fill(0),this.momentsR=Array.from({length:xt}).fill(0),this.momentsG=Array.from({length:xt}).fill(0),this.momentsB=Array.from({length:xt}).fill(0),this.moments=Array.from({length:xt}).fill(0);let e=Rt.quantize(t);for(let[n,a]of e.entries()){let o=mt(n),i=ft(n),c=pt(n),f=8-Lt,g=(o>>f)+1,m=(i>>f)+1,y=(c>>f)+1,P=this.getIndex(g,m,y);this.weights[P]=(this.weights[P]??0)+a,this.momentsR[P]+=a*o,this.momentsG[P]+=a*i,this.momentsB[P]+=a*c,this.moments[P]+=a*(o*o+i*i+c*c)}}computeMoments(){for(let t=1;t<Z;t++){let e=Array.from({length:Z}).fill(0),n=Array.from({length:Z}).fill(0),a=Array.from({length:Z}).fill(0),o=Array.from({length:Z}).fill(0),i=Array.from({length:Z}).fill(0);for(let c=1;c<Z;c++){let f=0,g=0,m=0,y=0,P=0;for(let d=1;d<Z;d++){let p=this.getIndex(t,c,d);f+=this.weights[p],g+=this.momentsR[p],m+=this.momentsG[p],y+=this.momentsB[p],P+=this.moments[p],e[d]+=f,n[d]+=g,a[d]+=m,o[d]+=y,i[d]+=P;let l=this.getIndex(t-1,c,d);this.weights[p]=this.weights[l]+e[d],this.momentsR[p]=this.momentsR[l]+n[d],this.momentsG[p]=this.momentsG[l]+a[d],this.momentsB[p]=this.momentsB[l]+o[d],this.moments[p]=this.moments[l]+i[d]}}}}createBoxes(t){this.cubes=Array.from({length:t}).fill(0).map(()=>new ie);let e=Array.from({length:t}).fill(0);this.cubes[0].r0=0,this.cubes[0].g0=0,this.cubes[0].b0=0,this.cubes[0].r1=Z-1,this.cubes[0].g1=Z-1,this.cubes[0].b1=Z-1;let n=t,a=0;for(let o=1;o<t;o++){this.cut(this.cubes[a],this.cubes[o])?(e[a]=this.cubes[a].vol>1?this.variance(this.cubes[a]):0,e[o]=this.cubes[o].vol>1?this.variance(this.cubes[o]):0):(e[a]=0,o--),a=0;let i=e[0];for(let c=1;c<=o;c++)e[c]>i&&(i=e[c],a=c);if(i<=0){n=o+1;break}}return new se(t,n)}createResult(t){let e=[];for(let n=0;n<t;++n){let a=this.cubes[n],o=this.volume(a,this.weights);if(o>0){let i=Math.round(this.volume(a,this.momentsR)/o),c=Math.round(this.volume(a,this.momentsG)/o),f=Math.round(this.volume(a,this.momentsB)/o),g=255<<24|(i&255)<<16|(c&255)<<8|f&255;e.push(g)}}return e}variance(t){let e=this.volume(t,this.momentsR),n=this.volume(t,this.momentsG),a=this.volume(t,this.momentsB),o=this.moments[this.getIndex(t.r1,t.g1,t.b1)]-this.moments[this.getIndex(t.r1,t.g1,t.b0)]-this.moments[this.getIndex(t.r1,t.g0,t.b1)]+this.moments[this.getIndex(t.r1,t.g0,t.b0)]-this.moments[this.getIndex(t.r0,t.g1,t.b1)]+this.moments[this.getIndex(t.r0,t.g1,t.b0)]+this.moments[this.getIndex(t.r0,t.g0,t.b1)]-this.moments[this.getIndex(t.r0,t.g0,t.b0)],i=e*e+n*n+a*a,c=this.volume(t,this.weights);return o-i/c}cut(t,e){let n=this.volume(t,this.momentsR),a=this.volume(t,this.momentsG),o=this.volume(t,this.momentsB),i=this.volume(t,this.weights),c=this.maximize(t,K.RED,t.r0+1,t.r1,n,a,o,i),f=this.maximize(t,K.GREEN,t.g0+1,t.g1,n,a,o,i),g=this.maximize(t,K.BLUE,t.b0+1,t.b1,n,a,o,i),m,y=c.maximum,P=f.maximum,d=g.maximum;if(y>=P&&y>=d){if(c.cutLocation<0)return!1;m=K.RED}else P>=y&&P>=d?m=K.GREEN:m=K.BLUE;switch(e.r1=t.r1,e.g1=t.g1,e.b1=t.b1,m){case K.RED:t.r1=c.cutLocation,e.r0=t.r1,e.g0=t.g0,e.b0=t.b0;break;case K.GREEN:t.g1=f.cutLocation,e.r0=t.r0,e.g0=t.g1,e.b0=t.b0;break;case K.BLUE:t.b1=g.cutLocation,e.r0=t.r0,e.g0=t.g0,e.b0=t.b1;break;default:throw new Error("unexpected direction "+m)}return t.vol=(t.r1-t.r0)*(t.g1-t.g0)*(t.b1-t.b0),e.vol=(e.r1-e.r0)*(e.g1-e.g0)*(e.b1-e.b0),!0}maximize(t,e,n,a,o,i,c,f){let g=this.bottom(t,e,this.momentsR),m=this.bottom(t,e,this.momentsG),y=this.bottom(t,e,this.momentsB),P=this.bottom(t,e,this.weights),d=0,p=-1,l=0,C=0,v=0,S=0;for(let k=n;k<a;k++){if(l=g+this.top(t,e,k,this.momentsR),C=m+this.top(t,e,k,this.momentsG),v=y+this.top(t,e,k,this.momentsB),S=P+this.top(t,e,k,this.weights),S===0)continue;let I=(l*l+C*C+v*v)*1,L=S*1,O=I/L;l=o-l,C=i-C,v=c-v,S=f-S,S!==0&&(I=(l*l+C*C+v*v)*1,L=S*1,O+=I/L,O>d&&(d=O,p=k))}return new ce(p,d)}volume(t,e){return e[this.getIndex(t.r1,t.g1,t.b1)]-e[this.getIndex(t.r1,t.g1,t.b0)]-e[this.getIndex(t.r1,t.g0,t.b1)]+e[this.getIndex(t.r1,t.g0,t.b0)]-e[this.getIndex(t.r0,t.g1,t.b1)]+e[this.getIndex(t.r0,t.g1,t.b0)]+e[this.getIndex(t.r0,t.g0,t.b1)]-e[this.getIndex(t.r0,t.g0,t.b0)]}bottom(t,e,n){switch(e){case K.RED:return-n[this.getIndex(t.r0,t.g1,t.b1)]+n[this.getIndex(t.r0,t.g1,t.b0)]+n[this.getIndex(t.r0,t.g0,t.b1)]-n[this.getIndex(t.r0,t.g0,t.b0)];case K.GREEN:return-n[this.getIndex(t.r1,t.g0,t.b1)]+n[this.getIndex(t.r1,t.g0,t.b0)]+n[this.getIndex(t.r0,t.g0,t.b1)]-n[this.getIndex(t.r0,t.g0,t.b0)];case K.BLUE:return-n[this.getIndex(t.r1,t.g1,t.b0)]+n[this.getIndex(t.r1,t.g0,t.b0)]+n[this.getIndex(t.r0,t.g1,t.b0)]-n[this.getIndex(t.r0,t.g0,t.b0)];default:throw new Error("unexpected direction $direction")}}top(t,e,n,a){switch(e){case K.RED:return a[this.getIndex(n,t.g1,t.b1)]-a[this.getIndex(n,t.g1,t.b0)]-a[this.getIndex(n,t.g0,t.b1)]+a[this.getIndex(n,t.g0,t.b0)];case K.GREEN:return a[this.getIndex(t.r1,n,t.b1)]-a[this.getIndex(t.r1,n,t.b0)]-a[this.getIndex(t.r0,n,t.b1)]+a[this.getIndex(t.r0,n,t.b0)];case K.BLUE:return a[this.getIndex(t.r1,t.g1,n)]-a[this.getIndex(t.r1,t.g0,n)]-a[this.getIndex(t.r0,t.g1,n)]+a[this.getIndex(t.r0,t.g0,n)];default:throw new Error("unexpected direction $direction")}}getIndex(t,e,n){return(t<<Lt*2)+(t<<Lt+1)+t+(e<<Lt)+e+n}},ie=class{constructor(t=0,e=0,n=0,a=0,o=0,i=0,c=0){this.r0=t,this.r1=e,this.g0=n,this.g1=a,this.b0=o,this.b1=i,this.vol=c}},se=class{constructor(t,e){this.requestedCount=t,this.resultCount=e}},ce=class{constructor(t,e){this.cutLocation=t,this.maximum=e}};var At=class{static quantize(t,e){let a=new Ot().quantize(t,e);return Bt.quantize(t,a,e)}};var Vt=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.CONTENT,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Nt=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.EXPRESSIVE,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Ht=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.FIDELITY,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Ut=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.FRUIT_SALAD,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var _t=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.MONOCHROME,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var zt=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.NEUTRAL,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Gt=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.RAINBOW,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Yt=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.TONAL_SPOT,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Kt=class extends F{constructor(t,e,n,a=F.DEFAULT_SPEC_VERSION,o=F.DEFAULT_PLATFORM){super({sourceColorHct:t,variant:s.VIBRANT,contrastLevel:n,isDark:e,platform:o,specVersion:a})}};var Ge={desired:4,fallbackColorARGB:4282549748,filter:!0};function Ye(r,t){return r.score>t.score?-1:r.score<t.score?1:0}var Q=class r{constructor(){}static score(t,e){let{desired:n,fallbackColorARGB:a,filter:o}={...Ge,...e},i=[],c=new Array(360).fill(0),f=0;for(let[d,p]of t.entries()){let l=T.fromInt(d);i.push(l);let C=Math.floor(l.hue);c[C]+=p,f+=p}let g=new Array(360).fill(0);for(let d=0;d<360;d++){let p=c[d]/f;for(let l=d-14;l<d+16;l++){let C=lt(l);g[C]+=p}}let m=new Array;for(let d of i){let p=lt(Math.round(d.hue)),l=g[p];if(o&&(d.chroma<r.CUTOFF_CHROMA||l<=r.CUTOFF_EXCITED_PROPORTION))continue;let C=l*100*r.WEIGHT_PROPORTION,v=d.chroma<r.TARGET_CHROMA?r.WEIGHT_CHROMA_BELOW:r.WEIGHT_CHROMA_ABOVE,S=(d.chroma-r.TARGET_CHROMA)*v,k=C+S;m.push({hct:d,score:k})}m.sort(Ye);let y=[];for(let d=90;d>=15;d--){y.length=0;for(let{hct:p}of m)if(y.find(C=>Jt(p.hue,C.hue)<d)||y.push(p),y.length>=n)break;if(y.length>=n)break}let P=[];y.length===0&&P.push(a);for(let d of y)P.push(d.toInt());return P}};Q.TARGET_CHROMA=48;Q.WEIGHT_PROPORTION=.7;Q.WEIGHT_CHROMA_ABOVE=.3;Q.WEIGHT_CHROMA_BELOW=.1;Q.CUTOFF_CHROMA=5;Q.CUTOFF_EXCITED_PROPORTION=.01;function ue(r){let t=mt(r),e=ft(r),n=pt(r),a=[t.toString(16),e.toString(16),n.toString(16)];for(let[o,i]of a.entries())i.length===1&&(a[o]="0"+i);return"#"+a.join("")}function Ae(r){r=r.replace("#","");let t=r.length===3,e=r.length===6,n=r.length===8;if(!t&&!e&&!n)throw new Error("unexpected hex "+r);let a=0,o=0,i=0;return t?(a=nt(r.slice(0,1).repeat(2)),o=nt(r.slice(1,2).repeat(2)),i=nt(r.slice(2,3).repeat(2))):e?(a=nt(r.slice(0,2)),o=nt(r.slice(2,4)),i=nt(r.slice(4,6))):n&&(a=nt(r.slice(2,4)),o=nt(r.slice(4,6)),i=nt(r.slice(6,8))),(255<<24|(a&255)<<16|(o&255)<<8|i&255)>>>0}function nt(r){return parseInt(r,16)}return Me(Ke);})();
/*! Bundled license information:

@material/material-color-utilities/utils/math_utils.js:
@material/material-color-utilities/utils/color_utils.js:
@material/material-color-utilities/hct/viewing_conditions.js:
@material/material-color-utilities/hct/cam16.js:
@material/material-color-utilities/hct/hct_solver.js:
@material/material-color-utilities/hct/hct.js:
@material/material-color-utilities/blend/blend.js:
@material/material-color-utilities/palettes/tonal_palette.js:
@material/material-color-utilities/palettes/core_palette.js:
@material/material-color-utilities/quantize/lab_point_provider.js:
@material/material-color-utilities/quantize/quantizer_wsmeans.js:
@material/material-color-utilities/quantize/quantizer_map.js:
@material/material-color-utilities/quantize/quantizer_wu.js:
@material/material-color-utilities/quantize/quantizer_celebi.js:
@material/material-color-utilities/scheme/scheme.js:
@material/material-color-utilities/scheme/scheme_android.js:
@material/material-color-utilities/score/score.js:
@material/material-color-utilities/utils/string_utils.js:
@material/material-color-utilities/utils/image_utils.js:
@material/material-color-utilities/utils/theme_utils.js:
@material/material-color-utilities/index.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@material/material-color-utilities/contrast/contrast.js:
@material/material-color-utilities/dynamiccolor/dynamic_color.js:
@material/material-color-utilities/dynamiccolor/variant.js:
@material/material-color-utilities/dynamiccolor/material_dynamic_colors.js:
@material/material-color-utilities/dynamiccolor/dynamic_scheme.js:
@material/material-color-utilities/scheme/scheme_expressive.js:
@material/material-color-utilities/scheme/scheme_fruit_salad.js:
@material/material-color-utilities/scheme/scheme_monochrome.js:
@material/material-color-utilities/scheme/scheme_neutral.js:
@material/material-color-utilities/scheme/scheme_rainbow.js:
@material/material-color-utilities/scheme/scheme_tonal_spot.js:
@material/material-color-utilities/scheme/scheme_vibrant.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@material/material-color-utilities/dislike/dislike_analyzer.js:
@material/material-color-utilities/temperature/temperature_cache.js:
@material/material-color-utilities/dynamiccolor/contrast_curve.js:
@material/material-color-utilities/dynamiccolor/tone_delta_pair.js:
@material/material-color-utilities/scheme/scheme_content.js:
@material/material-color-utilities/scheme/scheme_fidelity.js:
  (**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@material/material-color-utilities/dynamiccolor/color_spec_2021.js:
@material/material-color-utilities/dynamiccolor/color_spec_2025.js:
  (**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
*/
/*__MCU_END__*/
/*! Bundled license information:

@material/material-color-utilities/utils/math_utils.js:
@material/material-color-utilities/utils/color_utils.js:
@material/material-color-utilities/hct/viewing_conditions.js:
@material/material-color-utilities/hct/cam16.js:
@material/material-color-utilities/hct/hct_solver.js:
@material/material-color-utilities/hct/hct.js:
@material/material-color-utilities/blend/blend.js:
@material/material-color-utilities/palettes/tonal_palette.js:
@material/material-color-utilities/palettes/core_palette.js:
@material/material-color-utilities/quantize/lab_point_provider.js:
@material/material-color-utilities/quantize/quantizer_wsmeans.js:
@material/material-color-utilities/quantize/quantizer_map.js:
@material/material-color-utilities/quantize/quantizer_wu.js:
@material/material-color-utilities/quantize/quantizer_celebi.js:
@material/material-color-utilities/scheme/scheme.js:
@material/material-color-utilities/scheme/scheme_android.js:
@material/material-color-utilities/score/score.js:
@material/material-color-utilities/utils/string_utils.js:
@material/material-color-utilities/utils/image_utils.js:
@material/material-color-utilities/utils/theme_utils.js:
@material/material-color-utilities/index.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@material/material-color-utilities/contrast/contrast.js:
@material/material-color-utilities/dynamiccolor/dynamic_color.js:
@material/material-color-utilities/dynamiccolor/variant.js:
@material/material-color-utilities/dynamiccolor/material_dynamic_colors.js:
@material/material-color-utilities/dynamiccolor/dynamic_scheme.js:
@material/material-color-utilities/scheme/scheme_expressive.js:
@material/material-color-utilities/scheme/scheme_fruit_salad.js:
@material/material-color-utilities/scheme/scheme_monochrome.js:
@material/material-color-utilities/scheme/scheme_neutral.js:
@material/material-color-utilities/scheme/scheme_rainbow.js:
@material/material-color-utilities/scheme/scheme_tonal_spot.js:
@material/material-color-utilities/scheme/scheme_vibrant.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@material/material-color-utilities/dislike/dislike_analyzer.js:
@material/material-color-utilities/temperature/temperature_cache.js:
@material/material-color-utilities/dynamiccolor/contrast_curve.js:
@material/material-color-utilities/dynamiccolor/tone_delta_pair.js:
@material/material-color-utilities/scheme/scheme_content.js:
@material/material-color-utilities/scheme/scheme_fidelity.js:
  (**
   * @license
   * Copyright 2023 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)

@material/material-color-utilities/dynamiccolor/color_spec_2021.js:
@material/material-color-utilities/dynamiccolor/color_spec_2025.js:
  (**
   * @license
   * Copyright 2025 Google LLC
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *      http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   *)
*/
		//#endregion
		const { QuantizerCelebi, Score, Hct, SchemeTonalSpot, SchemeVibrant, SchemeExpressive, SchemeFidelity, SchemeContent, SchemeRainbow, SchemeFruitSalad, SchemeMonochrome, SchemeNeutral, argbFromHex, hexFromArgb, argbFromRgb } = MCU;

		const name = "dsh-plugin-background";
		const SETTINGS_NS = "ui-background";
		const SETTINGS_LOCALE_NS = "settings.background";
		const DEFAULT_OPACITY = 0.2;

		/** M3 dynamic-color variants (labels under background.variant.*). */
		const VARIANTS = [
			["tonalSpot", SchemeTonalSpot],
			["vibrant", SchemeVibrant],
			["expressive", SchemeExpressive],
			["fidelity", SchemeFidelity],
			["content", SchemeContent],
			["rainbow", SchemeRainbow],
			["fruitSalad", SchemeFruitSalad],
			["monochrome", SchemeMonochrome],
			["neutral", SchemeNeutral]
		];
		const VARIANT_SCHEMES = Object.fromEntries(VARIANTS);
		const VARIANT_IDS = VARIANTS.map(([id]) => id);
		const DEFAULT_VARIANT = "tonalSpot";

		/** State fields that feed the generated theme (opacity does not). */
		const THEME_RELEVANT = new Set(["wallpaper", "customUrl", "themeFromWallpaper", "variant"]);

		/** Roles of the shiki css-variables syntax theme. */
		const SHIKI_ROLES = ["constant", "string", "comment", "keyword", "parameter", "function", "string-expression", "punctuation", "link"];

		/**
		 * Wallpaper + settings-row styles. The wallpaper layer is a fixed
		 * body::before; the app frame (which paints --dsw-alias-bg-base) is made
		 * transparent only while a wallpaper is active (body[data-dsh-wallpaper="on"]),
		 * so the default look is untouched when the wallpaper is off.
		 */
		const PLUGIN_CSS = [
			"body::before{content:\"\";position:fixed;inset:0;z-index:0;pointer-events:none;background-image:var(--dsh-wallpaper-image,none);background-size:cover;background-position:center;background-repeat:no-repeat;opacity:var(--dsh-wallpaper-opacity,.2);transition:opacity .2s ease}",
			"body[data-dsh-wallpaper=\"on\"]:not([data-ds-dark-theme])::before{box-shadow:inset 0 0 0 9999px rgba(255,255,255,calc((1 - var(--dsh-wallpaper-opacity,.2))*.32))}",
			"body[data-dsh-wallpaper=\"on\"][data-ds-dark-theme]::before{box-shadow:inset 0 0 0 9999px rgba(12,14,18,calc((1 - var(--dsh-wallpaper-opacity,.2))*.45))}",
			"body[data-dsh-wallpaper=\"on\"]{--dsw-alias-bg-base:transparent!important;--dsw-specific-sidebar-fill:rgba(249,250,251,.55)!important}",
			"body[data-dsh-wallpaper=\"on\"][data-ds-dark-theme]{--dsw-alias-bg-base:transparent!important;--dsw-specific-sidebar-fill:rgba(19,20,23,.62)!important}",
			/* frosted-glass sidebar: blur only the wallpaper behind the translucent
			   fill. Never put backdrop-filter (or filter/transform) on the sidebar
			   root itself: any of those makes the root a containing block for fixed
			   descendants, which breaks the position:fixed settings overlay that
			   lives inside the sidebar subtree (it gets squeezed into the sidebar). */
			"body[data-dsh-wallpaper=\"on\"] .hHd-Xa_root{position:relative}",
			"body[data-dsh-wallpaper=\"on\"] .hHd-Xa_root::before{content:\"\";position:absolute;inset:0;z-index:0;pointer-events:none;backdrop-filter:blur(16px) saturate(1.15)}",
			/* Lift the sidebar content above the blur layer with position only:
			   z-index (even 1) would create a stacking context on the footer, which
			   traps the z-index:1000 settings overlay inside it and lets the
			   composer paint above the settings panel. position:relative (z-auto)
			   paints after the ::before in tree order without any stacking context,
			   so content stays sharp AND the overlay keeps its top-level z-index. */
			"body[data-dsh-wallpaper=\"on\"] .hHd-Xa_root>*{position:relative}",
			/* session markdown bold follows the generated theme (default when vars unset) */
			"[data-chat-flow] strong{color:var(--dsh-plugin-strong-light)}",
			"body[data-ds-dark-theme] [data-chat-flow] strong{color:var(--dsh-plugin-strong-dark)}",
			/* generated syntax highlighting (shiki css-variables theme); falls back to the preset palette when the vars are unset */
			":root{--shiki-token-constant:var(--dsh-shiki-constant-light);--shiki-token-string:var(--dsh-shiki-string-light);--shiki-token-comment:var(--dsh-shiki-comment-light);--shiki-token-keyword:var(--dsh-shiki-keyword-light);--shiki-token-parameter:var(--dsh-shiki-parameter-light);--shiki-token-function:var(--dsh-shiki-function-light);--shiki-token-string-expression:var(--dsh-shiki-string-expression-light);--shiki-token-punctuation:var(--dsh-shiki-punctuation-light);--shiki-token-link:var(--dsh-shiki-link-light)}",
			"body[data-ds-dark-theme]{--shiki-token-constant:var(--dsh-shiki-constant-dark);--shiki-token-string:var(--dsh-shiki-string-dark);--shiki-token-comment:var(--dsh-shiki-comment-dark);--shiki-token-keyword:var(--dsh-shiki-keyword-dark);--shiki-token-parameter:var(--dsh-shiki-parameter-dark);--shiki-token-function:var(--dsh-shiki-function-dark);--shiki-token-string-expression:var(--dsh-shiki-string-expression-dark);--shiki-token-punctuation:var(--dsh-shiki-punctuation-dark);--shiki-token-link:var(--dsh-shiki-link-dark)}",
			/* settings row */
			".dbg-group{border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;padding:16px 0;display:flex}",
			".dbg-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
			".dbg-field{flex-direction:column;gap:6px;display:flex;max-width:520px}",
			".dbg-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dbg-inputRow{display:flex;gap:8px;align-items:center}",
			".dbg-input{box-sizing:border-box;flex:1;min-width:0;height:32px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font-size:13px;font-family:inherit}",
			".dbg-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dbg-clear{box-sizing:border-box;height:32px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:8px;padding:0 12px;font-size:12px;font-family:inherit;cursor:pointer}",
			".dbg-clear:hover{background:var(--dsw-alias-interactive-bg-active)}",
			".dbg-clear:disabled{opacity:.6;cursor:default}",
			".dbg-uploadError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;min-width:0;overflow-wrap:anywhere}",
			".dbg-sliderRow{align-items:center;gap:10px;display:flex;max-width:520px}",
			".dbg-slider{flex:1;accent-color:var(--dsw-alias-state-business-primary)}",
			".dbg-opacityValue{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:38px;text-align:right}",
			".dbg-toggle{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;max-width:520px}",
			".dbg-toggle input{accent-color:var(--dsw-alias-state-business-primary)}",
			".dbg-select{box-sizing:border-box;height:32px;max-width:520px;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 8px;font-size:13px;font-family:inherit}",
			".dbg-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
			".dbg-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}"
		].join("\n");

		function injectWallpaperCss() {
			document.querySelectorAll('style[data-plugin-css="dsh-plugin-background/wallpaper.css"]').forEach((el) => el.remove());
			const tag = document.createElement("style");
			tag.dataset.plugin = name;
			tag.dataset.pluginCss = "dsh-plugin-background/wallpaper.css";
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}

		function clamp01(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_OPACITY;
			return Math.min(1, Math.max(0, value));
		}

		/** Escape a URL for embedding inside a CSS url("...") literal. */
		function cssEscapeUrl(url) {
			return String(url).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r]/g, " ");
		}

		/** Resolve the current selection to a CSS background-image value. */
		function resolveImage(wallpaper, customUrl) {
			if (wallpaper !== "custom") return "none";
			const url = String(customUrl || "").trim();
			const allowed = /^(https?:)?\/\//.test(url) || /^data:image\//.test(url) || /^\/(?!\/)/.test(url);
			if (!url || !allowed) return "none";
			return `url("${cssEscapeUrl(url)}")`;
		}

		/** Push the current state into the DOM (CSS variables + active flag). */
		function publish(state) {
			const image = resolveImage(state.wallpaper, state.customUrl);
			document.body.style.setProperty("--dsh-wallpaper-image", image);
			document.body.style.setProperty("--dsh-wallpaper-opacity", String(state.opacity));
			document.body.dataset.dshWallpaper = image === "none" ? "off" : "on";
		}

		/**
		 * Load an image URL into an offscreen canvas and return its pixels as
		 * ARGB ints (downscaled). Resolves null on any failure — including
		 * cross-origin images without CORS headers (canvas taint).
		 */
		function sampleArgbPixels(url, size = 32) {
			return new Promise((resolve) => {
				if (typeof Image === "undefined") {
					resolve(null);
					return;
				}
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.onload = () => {
					try {
						const canvas = document.createElement("canvas");
						canvas.width = size;
						canvas.height = size;
						const ctx = canvas.getContext("2d", { willReadFrequently: true });
						if (!ctx) {
							resolve(null);
							return;
						}
						ctx.drawImage(img, 0, 0, size, size);
						const data = ctx.getImageData(0, 0, size, size).data;
						const pixels = [];
						for (let i = 0; i < data.length; i += 4) {
							if (data[i + 3] < 128) continue;
							pixels.push(argbFromRgb(data[i], data[i + 1], data[i + 2]));
						}
						resolve(pixels.length > 0 ? pixels : null);
					} catch {
						resolve(null);
					}
				};
				img.onerror = () => resolve(null);
				img.src = url;
			});
		}

		/**
		 * Resolve the current wallpaper selection to an M3 seed color (ARGB int):
		 * presets use their declared seed; custom images are sampled and scored
		 * with the real Material You pipeline (quantize -> score). Null when no
		 * wallpaper is active or the image cannot be read.
		 */
		async function resolveSeed(state) {
			if (state.wallpaper !== "custom") return null;
			const url = String(state.customUrl || "").trim();
			if (!url) return null;
			const pixels = await sampleArgbPixels(url);
			if (!pixels) return null;
			try {
				const quantized = QuantizerCelebi.quantize(pixels, 16);
				const scored = Score.score(quantized);
				return scored.length > 0 ? scored[0] : null;
			} catch {
				return null;
			}
		}

		/**
		 * Map an M3 dynamic-color scheme (variant) to DSH alias-token overrides
		 * as {light, dark} pairs (the ctx.theme.overrideTokens contract). The
		 * scheme classes are the official M3 variant implementations; markdown
		 * surfaces reuse the generated containers so the session markdown
		 * follows the wallpaper theme too.
		 * @param seedArgb - M3 seed color (ARGB int).
		 * @param variantId - one of VARIANT_IDS (defaults to tonalSpot).
		 */
		/** Build the light/dark scheme pair for a seed and variant. */
		function schemesFor(seedArgb, variantId = DEFAULT_VARIANT) {
			const Scheme = VARIANT_SCHEMES[variantId] || SchemeTonalSpot;
			const hct = Hct.fromInt(seedArgb);
			return { hct, light: new Scheme(hct, false, 0), dark: new Scheme(hct, true, 0) };
		}

		function buildThemeTokens(seedArgb, variantId = DEFAULT_VARIANT) {
			const { light, dark } = schemesFor(seedArgb, variantId);
			const hex = (argb) => hexFromArgb(argb);
			const hover = (schemeColor, tone) => {
				const h = Hct.fromInt(schemeColor);
				h.tone = tone;
				return hexFromArgb(h.toInt());
			};
			const tint = (schemeColor, alpha) => `color-mix(in srgb, ${hex(schemeColor)} ${alpha}, transparent)`;
			return {
				"--dsw-alias-state-business-primary": { light: hex(light.primary), dark: hex(dark.primary) },
				"--dsw-alias-brand-primary": { light: hex(light.primary), dark: hex(dark.primary) },
				"--dsw-alias-brand-text": { light: hex(light.primary), dark: hex(dark.primary) },
				"--dsw-alias-button-primary-fill": { light: hex(light.primary), dark: hex(dark.primary) },
				"--dsw-alias-button-primary-hover": { light: hover(light.primary, 50), dark: hover(dark.primary, 70) },
				"--dsw-alias-button-info-fill": { light: hex(light.primary), dark: hex(dark.primary) },
				"--dsw-alias-button-info-hover": { light: hover(light.primary, 50), dark: hover(dark.primary, 70) },
				"--dsw-alias-state-business-tertiary": { light: hex(light.tertiaryContainer), dark: hex(dark.tertiaryContainer) },
				"--dsw-specific-bubble": { light: hex(light.secondaryContainer), dark: hex(dark.secondaryContainer) },
				"--dsw-specific-bubble-highlight": { light: hex(light.primaryContainer), dark: hex(dark.primaryContainer) },
				"--dsw-specific-sidebar-nav-item-active-accent": { light: hex(light.primaryContainer), dark: hex(dark.primaryContainer) },
				"--dsw-alias-interactive-bg-hover-accent": { light: tint(light.primary, "14%"), dark: tint(dark.primary, "24%") },
				"--dsw-alias-interactive-bg-active": { light: tint(light.primary, "10%"), dark: tint(dark.primary, "14%") },
				/* session markdown follows the generated palette */
				"--dsw-alias-markdown-inline-code": { light: hex(light.primaryContainer), dark: hex(dark.primaryContainer) },
				"--dsw-alias-markdown-code-block": { light: hex(light.surfaceContainerHighest), dark: hex(dark.surfaceContainerHighest) },
				"--dsw-alias-markdown-code-block-banner": { light: hex(light.secondaryContainer), dark: hex(dark.secondaryContainer) },
				"--dsw-alias-markdown-citation": { light: hex(light.tertiaryContainer), dark: hex(dark.tertiaryContainer) },
				"--dsw-alias-markdown-tag": { light: hex(light.secondaryContainer), dark: hex(dark.secondaryContainer) },
				/* custom var consumed by the plugin's own CSS: session bold color */
				"--dsh-plugin-bg-strong-color": { light: hex(light.primary), dark: hex(dark.primary) }
			};
		}

/**
		 * Syntax-highlight roles (the shiki css-variables theme's --shiki-token-*).
		 * Follows the iNiR dotfiles approach: every role keeps a distinct anchor
		 * hue (classic syntax palette), the wallpaper supplies chroma and tone,
		 * and the color is blended 28% toward the scheme primary so it harmonizes
		 * with the generated theme while staying readable on the code-block
		 * background. Comment/parameter/punctuation stay neutral (onSurfaceVariant)
		 * so variables never clash with the wallpaper.
		 * @returns { light, dark } maps of role -> hex.
		 */
		function buildSyntaxTokens(seedArgb, variantId = DEFAULT_VARIANT) {
			const { hct, light, dark } = schemesFor(seedArgb, variantId);
			const chroma = Math.min(72, Math.max(30, hct.chroma));
			/** Blend a color's HUE 28% toward the wallpaper seed hue (HCT space,
			 * like Material blendHctHue) so roles harmonize without losing
			 * distinctness; chroma and tone stay anchored for readability. */
			const blend = (baseArgb) => {
				const b = Hct.fromInt(baseArgb);
				const delta = ((hct.hue - b.hue + 540) % 360) - 180;
				const hue = (b.hue + delta * 0.28 + 360) % 360;
				return hexFromArgb(Hct.from(hue, b.chroma, b.tone).toInt());
			};
			const anchored = (anchorHue, tone) => blend(Hct.from(anchorHue, chroma, tone).toInt());
			const mode = (tone, exprTone, scheme) => ({
				constant: anchored(60, tone),
				string: anchored(120, tone),
				comment: hexFromArgb(scheme.onSurfaceVariant),
				keyword: anchored(320, tone),
				parameter: hexFromArgb(scheme.onSurfaceVariant),
				function: anchored(240, tone),
				"string-expression": anchored(120, exprTone),
				punctuation: hexFromArgb(scheme.onSurfaceVariant),
				link: anchored(240, tone)
			});
			return { light: mode(45, 55, light), dark: mode(68, 78, dark) };
		}

		/** Mirror store for the settings row (the theme row pattern). */
		function createBackgroundRowStore() {
			return defineStore({
				init: () => ({ wallpaper: "none", customUrl: "", opacity: DEFAULT_OPACITY, themeFromWallpaper: true, variant: DEFAULT_VARIANT, uploading: false, uploadError: "", revision: -1 }),
				actions: {
					sync: (d, wallpaper, customUrl, opacity, themeFromWallpaper, variant, revision) => {
						if (revision <= d.revision) return;
						d.wallpaper = wallpaper;
						d.customUrl = customUrl;
						d.opacity = opacity;
						d.themeFromWallpaper = themeFromWallpaper;
						d.variant = variant;
						d.revision = revision;
					},
					setUploadStatus: (d, uploading, error) => {
						d.uploading = uploading;
						d.uploadError = error || "";
					}
				}
			});
		}

		/** Settings > General row: swatch picker, custom URL, local upload, opacity slider, theme toggle. */
		function BackgroundRow({ t, useStore, setCustomUrl, setOpacity, setThemeFromWallpaper, setVariant, upload }) {
			const s = useStore((st) => st);
			const opacityPct = Math.round(clamp01(s.opacity) * 100);
			return jsx("div", {
				className: "dbg-group",
				children: [
					jsx("div", { className: "dbg-title", children: t("background.title") }),
					jsx("div", {
						className: "dbg-field",
						children: [
							jsx("label", { className: "dbg-label", htmlFor: "dbg-custom-url", children: t("background.customUrl") }),
							jsx("div", {
								className: "dbg-inputRow",
								children: [
									jsx("input", {
										id: "dbg-custom-url",
										className: "dbg-input",
										type: "text",
										defaultValue: s.customUrl || "",
										placeholder: t("background.customUrlPlaceholder"),
										onBlur: (e) => {
											const value = String(e.target.value || "").trim();
											if (value === (s.customUrl || "")) return;
											setCustomUrl(value);
										}
									}),
									jsx("button", {
										type: "button",
										className: "dbg-clear",
										onClick: () => {
											const el = document.getElementById("dbg-custom-url");
											if (el) el.value = "";
											setCustomUrl("");
										},
										children: t("background.clear")
									})
								]
							})
						]
					}),
					jsx("div", {
						className: "dbg-field",
						children: [
							jsx("label", { className: "dbg-label", children: t("background.upload") }),
							jsx("div", {
								className: "dbg-inputRow",
								children: [
									jsx("button", {
										type: "button",
										className: "dbg-clear",
										disabled: s.uploading,
										onClick: () => { document.getElementById("dbg-file-input")?.click(); },
										children: s.uploading ? t("background.uploading") : t("background.uploadButton")
									}),
									jsx("input", {
										id: "dbg-file-input",
										type: "file",
										accept: "image/png,image/jpeg,image/gif,image/webp,image/avif",
										style: { display: "none" },
										onChange: (e) => { upload(e); }
									}),
									s.uploadError ? jsx("span", { className: "dbg-uploadError", children: t("background.uploadFailed") + "：" + (s.uploadError.startsWith("TOO_LARGE") ? t("background.uploadTooLarge", { limit: Math.max(1, Math.round(Number(s.uploadError.split(":")[1] || 0) / 1048576)) }) : s.uploadError) }) : null
								]
							})
						]
					}),
					jsx("div", {
						className: "dbg-sliderRow",
						children: [
							jsx("label", { className: "dbg-label", children: t("background.opacity") }),
							jsx("input", {
								className: "dbg-slider",
								type: "range",
								min: "0",
								max: "100",
								step: "5",
								defaultValue: String(opacityPct),
								onInput: (e) => {
									const value = Number(e.target.value) / 100;
									document.body.style.setProperty("--dsh-wallpaper-opacity", String(value));
									const label = e.currentTarget.parentElement?.querySelector(".dbg-opacityValue");
									if (label) label.textContent = Math.round(value * 100) + "%";
								},
								onChange: (e) => { setOpacity(Number(e.target.value) / 100); }
							}),
							jsx("span", { className: "dbg-opacityValue", children: opacityPct + "%" })
						]
					}),
					jsx("label", {
						className: "dbg-toggle",
						children: [
							jsx("input", {
								type: "checkbox",
								checked: !!s.themeFromWallpaper,
								onChange: (e) => { setThemeFromWallpaper(e.target.checked); }
							}),
							jsx("span", { children: t("background.themeToggle") })
						]
					}),
					jsx("div", {
						className: "dbg-field",
						children: [
							jsx("label", { className: "dbg-label", htmlFor: "dbg-variant", children: t("background.variant") }),
							jsx("select", {
								id: "dbg-variant",
								className: "dbg-select",
								value: s.variant,
								onChange: (e) => { setVariant(e.target.value); },
								children: VARIANT_IDS.map((id) => jsx("option", { key: id, value: id, children: t("background.variant." + id) }))
							})
						]
					}),
					jsx("div", { className: "dbg-hint", children: t("background.hint") })
				]
			});
		}

		/** Locale dictionaries for the settings row (zh is the key-set source of truth). */
		const zh = {
			"background.title": "背景",
			"background.customUrl": "自定义图片 URL",
			"background.customUrlPlaceholder": "https://example.com/wallpaper.jpg（支持 http(s) 或 data:image）",
			"background.clear": "清除",
			"background.upload": "本地图片",
			"background.uploadButton": "选择图片上传…",
			"background.uploading": "上传中…",
			"background.uploadFailed": "上传失败",
			"background.uploadTooLarge": "图片超过 {limit}MB 大小限制，请压缩后重试",
			"background.opacity": "不透明度",
			"background.themeToggle": "跟随壁纸生成主题配色（Material You 风格）",
			"background.variant": "配色变体",
			"background.variant.tonalSpot": "色调点（默认）",
			"background.variant.vibrant": "活力",
			"background.variant.expressive": "表现",
			"background.variant.fidelity": "忠实",
			"background.variant.content": "内容",
			"background.variant.rainbow": "彩虹",
			"background.variant.fruitSalad": "水果沙拉",
			"background.variant.monochrome": "单色",
			"background.variant.neutral": "中性",
			"background.hint": "填写图片 URL 或上传本地图片（PNG/JPG/GIF/WebP/AVIF，≤100MB）即启用壁纸，清空则恢复默认；壁纸显示在对话主区域、详情列与侧栏（毛玻璃半透明）。开启跟随配色后，主色/按钮/气泡/Markdown/代码高亮会从壁纸提取生成，并可切换 M3 配色变体"
		};
		const en = {
			"background.title": "Background",
			"background.customUrl": "Custom image URL",
			"background.customUrlPlaceholder": "https://example.com/wallpaper.jpg (http(s) or data:image)",
			"background.clear": "Clear",
			"background.upload": "Local image",
			"background.uploadButton": "Choose image…",
			"background.uploading": "Uploading…",
			"background.uploadFailed": "Upload failed",
			"background.uploadTooLarge": "Image exceeds the {limit}MB limit; compress it and try again",
			"background.opacity": "Opacity",
			"background.themeToggle": "Adaptive theme colors from wallpaper (Material You)",
			"background.variant": "Color variant",
			"background.variant.tonalSpot": "Tonal spot (default)",
			"background.variant.vibrant": "Vibrant",
			"background.variant.expressive": "Expressive",
			"background.variant.fidelity": "Fidelity",
			"background.variant.content": "Content",
			"background.variant.rainbow": "Rainbow",
			"background.variant.fruitSalad": "Fruit salad",
			"background.variant.monochrome": "Monochrome",
			"background.variant.neutral": "Neutral",
			"background.hint": "An image URL or a local upload (PNG/JPG/GIF/WebP/AVIF, ≤100MB) enables the wallpaper; clearing it restores the default. The wallpaper shows in the conversation area, details column, and the frosted translucent sidebar. With adaptive colors on, accents/buttons/bubbles/markdown/code highlighting are derived from the wallpaper and the M3 variant can be switched"
		};

		/** Required client services (the theme row's contract). */
		const inject = [
			"slots",
			"locale",
			"theme"
		];

		/**
		 * Client plugin body: own the `ui-background` settings scope, paint the
		 * wallpaper, derive an M3 (Material You) theme from the wallpaper seed,
		 * and register the Background row into the General section.
		 */
		function apply(ctx) {
			injectWallpaperCss();

			const store = createBackgroundRowStore();
			let bound;
			const state = { wallpaper: "none", customUrl: "", opacity: DEFAULT_OPACITY, themeFromWallpaper: true, variant: DEFAULT_VARIANT, revision: -1 };

			const publishState = () => publish(state);
			const syncStore = () => { if (bound) bound.sync(state.wallpaper, state.customUrl, state.opacity, state.themeFromWallpaper, state.variant, state.revision); };

			/** Adopt a validated config object (from the plugin-owned config file). */
			const applyConfig = (config) => {
				if (!config || typeof config !== "object") return;
				let changed = false;
				let themeChanged = false;
				const apply = (key, value) => {
					state[key] = value;
					changed = true;
					if (THEME_RELEVANT.has(key)) themeChanged = true;
				};
								if (typeof config.customUrl === "string" && config.customUrl !== state.customUrl) apply("customUrl", config.customUrl);
				if (typeof config.opacity === "number" && config.opacity !== state.opacity) apply("opacity", clamp01(config.opacity));
				if (typeof config.themeFromWallpaper === "boolean" && config.themeFromWallpaper !== state.themeFromWallpaper) apply("themeFromWallpaper", config.themeFromWallpaper);
				if (typeof config.variant === "string" && VARIANT_IDS.includes(config.variant) && config.variant !== state.variant) apply("variant", config.variant);
				const derivedWallpaper = state.customUrl.trim() ? "custom" : "none";
				if (derivedWallpaper !== state.wallpaper) {
					state.wallpaper = derivedWallpaper;
					changed = true;
					themeChanged = true;
				}
				if (!changed) return;
				state.revision += 1;
				publishState();
				syncStore();
				if (themeChanged) refreshThemeOverride();
			};

			/** Load the persisted configuration from the Host (plugin-owned file). */
			const loadConfig = async () => {
				try {
					const response = await fetch("/background/config", { method: "GET" });
					if (!response.ok) return;
					const config = await response.json();
					applyConfig(config);
				} catch {
					/* host route may be missing until the next restart; keep defaults */
				}
			};

			/** Debounced persistence of the whole state to the Host config file. */
			let saveTimer = null;
			const scheduleSave = () => {
				if (saveTimer !== null) clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					saveTimer = null;
					const payload = {
						wallpaper: state.wallpaper,
						customUrl: state.customUrl,
						opacity: state.opacity,
						themeFromWallpaper: state.themeFromWallpaper,
						variant: state.variant
					};
					fetch("/background/config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload)
					}).catch(() => { /* best-effort; the next change retries */ });
				}, 300);
			};

			/** Optimistically apply a user patch locally, then persist it. */
			const commit = (patch) => {
				let changed = false;
				let themeChanged = false;
				const apply = (key, value) => {
					state[key] = value;
					changed = true;
					if (THEME_RELEVANT.has(key)) themeChanged = true;
				};
								if (patch.customUrl !== undefined && patch.customUrl !== state.customUrl) apply("customUrl", patch.customUrl);
				if (patch.opacity !== undefined) {
					const value = clamp01(patch.opacity);
					if (value !== state.opacity) apply("opacity", value);
				}
				if (patch.themeFromWallpaper !== undefined && patch.themeFromWallpaper !== state.themeFromWallpaper) apply("themeFromWallpaper", patch.themeFromWallpaper);
				if (patch.variant !== undefined && VARIANT_IDS.includes(patch.variant) && patch.variant !== state.variant) apply("variant", patch.variant);
				const derivedWallpaper = state.customUrl.trim() ? "custom" : "none";
				if (derivedWallpaper !== state.wallpaper) {
					state.wallpaper = derivedWallpaper;
					changed = true;
					themeChanged = true;
				}
				if (!changed) return;
				state.revision += 1;
				publishState();
				syncStore();
				if (themeChanged) refreshThemeOverride();
				scheduleSave();
			};

			/**
			 * Derive the Material You theme from the active wallpaper and stack it
			 * on the theme registry (replaces the previous layer of this source).
			 * Disposes the override when the wallpaper is off, the toggle is off,
			 * or the seed cannot be resolved.
			 */
			let themeDisposer = null;
			let themeGen = 0;
			const disposeTheme = () => {
				if (themeDisposer) {
					themeDisposer();
					themeDisposer = null;
				}
				document.body.style.removeProperty("--dsh-plugin-strong-light");
				document.body.style.removeProperty("--dsh-plugin-strong-dark");
				for (const role of SHIKI_ROLES) {
					document.body.style.removeProperty(`--dsh-shiki-${role}-light`);
					document.body.style.removeProperty(`--dsh-shiki-${role}-dark`);
				}
			};
			const refreshThemeOverride = async () => {
				const gen = ++themeGen;
				disposeTheme();
				if (!state.themeFromWallpaper || !ctx.theme) return;
				const seed = await resolveSeed(state);
				if (gen !== themeGen) return;
				if (!seed) return;
				try {
					const tokens = buildThemeTokens(seed, state.variant);
					document.body.style.setProperty("--dsh-plugin-strong-light", tokens["--dsh-plugin-bg-strong-color"].light);
					document.body.style.setProperty("--dsh-plugin-strong-dark", tokens["--dsh-plugin-bg-strong-color"].dark);
					const syntax = buildSyntaxTokens(seed, state.variant);
					for (const role of SHIKI_ROLES) {
						document.body.style.setProperty(`--dsh-shiki-${role}-light`, syntax.light[role]);
						document.body.style.setProperty(`--dsh-shiki-${role}-dark`, syntax.dark[role]);
					}
					themeDisposer = ctx.theme.overrideTokens("dsh-plugin-background", tokens);
				} catch {
					/* the theme boundary may refuse an unusual seed; keep the default theme */
				}
			};

			/** Upload a picked local image to the Host and apply it as the wallpaper. */
			const handleUpload = async (event) => {
				const file = event.target.files?.[0];
				if (event.target.value) event.target.value = "";
				if (!file) return;
				bound?.setUploadStatus(true, "");
				try {
					const response = await fetch("/background/upload", {
						method: "POST",
						headers: { "Content-Type": file.type || "application/octet-stream" },
						body: file
					});
					if (response.status === 413) {
						let limit = 0;
						try {
							const payload = await response.json();
							limit = Number(payload?.limit) || 0;
						} catch { /* keep 0 */ }
						throw new Error(`TOO_LARGE:${limit}`);
					}
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					if (!data || typeof data.url !== "string") throw new Error("bad upload response");
					commit({ customUrl: data.url });
					bound?.setUploadStatus(false, "");
				} catch (err) {
					bound?.setUploadStatus(false, err instanceof Error ? err.message : String(err));
				}
			};

			const injected = (actions) => {
				bound = actions;
				return {
					setCustomUrl: (value) => { commit({ customUrl: value }); },
					setOpacity: (value) => { commit({ opacity: value }); },
					setThemeFromWallpaper: (value) => { commit({ themeFromWallpaper: !!value }); },
					setVariant: (value) => { commit({ variant: value }); },
					upload: handleUpload
				};
			};

			ctx.effect(() => ctx.locale.register(SETTINGS_LOCALE_NS, { zh, en }), "dsh-plugin-background: row dictionaries");
			ctx.effect(() => () => { disposeTheme(); }, "dsh-plugin-background: theme override teardown");
			loadConfig();
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "background",
				order: 20,
				store,
				locale: SETTINGS_LOCALE_NS,
				inject: injected
			}, BackgroundRow));
		}

		exports.name = name;
		exports.apply = apply;
		exports.inject = inject;
		exports.buildThemeTokens = buildThemeTokens;
		exports.buildSyntaxTokens = buildSyntaxTokens;
		exports.resolveSeed = resolveSeed;
		exports.sampleArgbPixels = sampleArgbPixels;
		return module.exports;
	}
});
