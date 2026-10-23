import {PDFArray,PDFDict,PDFName,PDFNumber} from 'pdf-lib';
const key=PDFName.of;
/** Raw, read-only evidence. A read-only field can still be encountered by a
 * reader, so the navigation planner must not silently discard it. */
export function widgetNavigationState(widget) {
  try {
    const flags=(dict,k)=>{const n=dict.lookup(key(k));if(n===undefined)return 0;if(!(n instanceof PDFNumber)||!Number.isInteger(n.asNumber())||n.asNumber()<0||n.asNumber()>0x7fffffff)throw Error('Invalid navigation flags');return n.asNumber();};
    let node=widget,fieldFlags=0;const seen=new Set();
    while(node){if(!(node instanceof PDFDict)||seen.has(node)||seen.size>=128)throw Error('Invalid navigation ancestry');seen.add(node);if(node.has(key('Ff'))){fieldFlags=flags(node,'Ff');break;}node=node.lookup(key('Parent'));}
    const rect=widget.lookup(key('Rect'));if(!(rect instanceof PDFArray)||rect.size()!==4)throw Error('Invalid widget rectangle');
    const values=Array.from({length:4},(_,i)=>rect.lookup(i));if(!values.every(n=>n instanceof PDFNumber&&Number.isFinite(n.asNumber())))throw Error('Invalid widget rectangle');const [x,y,r,t]=values.map(n=>n.asNumber());
    return {navigationState:{annotationFlags:flags(widget,'F'),fieldFlags,hasArea:x!==r&&y!==t,optionalContent:widget.has(key('OC'))}};
  }catch(error){return {navigationStateError:error.message};}
}
