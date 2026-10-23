import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;

/** Independent, read-only inspection of native option mappings and selection.
 * Does not use AcroForm accessors or generate widget appearances. */
final class ChoiceControlInspector {
    private final Map<COSDictionary,Map<COSDictionary,Map<String,Object>>> cache=new IdentityHashMap<>();
    private final Map<COSDictionary,String> errors=new IdentityHashMap<>();
    private static COSName key(String s){return COSName.getPDFName(s);}
    private static void require(boolean ok,String why)throws IOException{if(!ok)throw new IOException(why);}
    private static COSBase inherited(COSDictionary field,COSName property)throws IOException{
        Set<COSDictionary> seen=Collections.newSetFromMap(new IdentityHashMap<>());COSDictionary n=field;
        while(n!=null){require(seen.size()<128&&seen.add(n),"Invalid choice field ancestry");COSBase v=n.getDictionaryObject(property);if(v!=null)return v;COSBase p=n.getDictionaryObject(COSName.PARENT);require(p==null||p instanceof COSDictionary,"Invalid choice parent");n=(COSDictionary)p;}return null;
    }
    private static String text(COSBase raw)throws IOException{
        require(raw instanceof COSString,"Choice text must be a PDF string");String s=((COSString)raw).getString();require(s.length()<=4096&&!s.matches("(?s).*[\\x00-\\x1f\\x7f-\\x9f\\ufffd].*"),"Invalid choice text");return s;
    }
    private static String name(COSBase raw,String fallback)throws IOException{
        if(raw==null&&fallback!=null)return fallback;require(raw instanceof COSName,"Choice state must be a name");String s=((COSName)raw).getName();require(!s.isEmpty()&&s.length()<=256&&!s.matches("(?s).*[^\\x20-\\x7e].*"),"Unsupported choice state encoding");return s;
    }
    private static int integer(COSBase raw)throws IOException{require(raw instanceof COSInteger&&((COSInteger)raw).longValue()>=Integer.MIN_VALUE&&((COSInteger)raw).longValue()<=Integer.MAX_VALUE,"Choice index/flags must be an integer");return ((COSInteger)raw).intValue();}
    private static String ref(COSDictionary d)throws IOException{require(d.getKey()!=null,"Choice object lacks indirect identity");return d.getKey().getNumber()+" "+d.getKey().getGeneration()+" R";}
    void append(COSDictionary widget,Map<String,Object> output){
        try {
            COSDictionary field=widget;Set<COSDictionary> seen=Collections.newSetFromMap(new IdentityHashMap<>());
            while(!field.containsKey(COSName.T)&&!field.containsKey(COSName.FT)){require(seen.size()<128&&seen.add(field),"Invalid choice ancestry");COSBase parent=field.getDictionaryObject(COSName.PARENT);if(parent==null)return;require(parent instanceof COSDictionary,"Invalid choice parent");field=(COSDictionary)parent;}
            if(!cache.containsKey(field)&&!errors.containsKey(field)){try{cache.put(field,inspect(field));}catch(IOException e){errors.put(field,e.getMessage());}}
            if(errors.containsKey(field))output.put("choiceMetadataError",errors.get(field));
            else if(cache.get(field).containsKey(widget))output.put("choiceControl",cache.get(field).get(widget));
        }catch(IOException e){output.put("choiceMetadataError",e.getMessage());}
    }
    private static Map<COSDictionary,Map<String,Object>> inspect(COSDictionary field)throws IOException{
        Map<COSDictionary,Map<String,Object>> output=new IdentityHashMap<>();COSBase ft=inherited(field,COSName.FT);
        if(!COSName.BTN.equals(ft)&&!COSName.CH.equals(ft))return output;
        COSBase rawFlags=inherited(field,COSName.FF);int flags=rawFlags==null?0:integer(rawFlags);require(flags>=0,"Invalid choice flags");
        if(COSName.BTN.equals(ft)&&((flags&32768)==0||(flags&65536)!=0))return output;
        List<COSDictionary> widgets=new ArrayList<>();COSBase kids=field.getDictionaryObject(COSName.KIDS);
        if(kids==null)widgets.add(field);else{require(kids instanceof COSArray&&((COSArray)kids).size()<=1024,"Invalid choice widget inventory");COSArray a=(COSArray)kids;for(int i=0;i<a.size();i++){require(a.getObject(i) instanceof COSDictionary,"Invalid choice widget");widgets.add((COSDictionary)a.getObject(i));}}
        require(!widgets.isEmpty()&&new HashSet<>(widgets).size()==widgets.size(),"Duplicate choice widget");
        for(COSDictionary w:widgets){require(COSName.WIDGET.equals(w.getDictionaryObject(COSName.SUBTYPE))&&(w==field||w.getDictionaryObject(COSName.PARENT)==field),"Choice widget parent mismatch");ref(w);}
        COSBase tu=field.getDictionaryObject(COSName.TU);String groupName=tu==null?"":text(tu);String fieldRef=ref(field);
        for(int i=0;i<widgets.size();i++){Map<String,Object> m=new LinkedHashMap<>();m.put("fieldRef",fieldRef);m.put("groupName",groupName);m.put("flags",flags);m.put("widgetCount",widgets.size());m.put("widgetIndex",i);output.put(widgets.get(i),m);}
        if(COSName.BTN.equals(ft)){
            String value=name(inherited(field,COSName.V),"Off");COSBase opt=field.getDictionaryObject(COSName.OPT);require(opt==null||opt instanceof COSArray&&((COSArray)opt).size()==widgets.size(),"Radio Opt must match Kids exactly");List<Map<String,Object>> entries=new ArrayList<>();
            for(int i=0;i<widgets.size();i++){
                COSDictionary w=widgets.get(i);COSDictionary ap=w.getCOSDictionary(COSName.AP);COSBase raw=ap==null?null:ap.getDictionaryObject(COSName.N);require(raw instanceof COSDictionary&&!(raw instanceof COSStream),"Radio requires normal appearance states");COSDictionary normal=(COSDictionary)raw;
                List<COSName> on=normal.keySet().stream().filter(k->!COSName.Off.equals(k)).toList();require(on.size()==1&&normal.getDictionaryObject(on.get(0)) instanceof COSStream,"Radio requires one on-state stream");COSBase off=normal.getDictionaryObject(COSName.Off);require(off==null||off instanceof COSStream,"Invalid radio off appearance");
                String onState=name(on.get(0),null),as=name(w.getDictionaryObject(COSName.AS),"Off");List<String> issues=new ArrayList<>();if(!w.containsKey(COSName.AS))issues.add("MISSING_APPEARANCE_STATE");if(!as.equals(onState)&&!as.equals("Off"))issues.add("UNKNOWN_APPEARANCE_STATE");
                Map<String,Object> m=output.get(w);m.put("kind","radio");m.put("onState",onState);m.put("appearanceState",as);m.put("value",value);m.put("exportValue",opt==null?onState:text(((COSArray)opt).getObject(i)));m.put("exportSource",opt==null?"AP-N":"Opt");m.put("selected",as.equals(onState));m.put("stateIssues",issues);entries.add(m);
            }
            List<Map<String,Object>> selected=entries.stream().filter(m->Boolean.TRUE.equals(m.get("selected"))).toList();boolean unison=(flags&33554432)!=0;List<String> issues=new ArrayList<>();
            if(!value.equals("Off")&&entries.stream().noneMatch(m->value.equals(m.get("onState"))))issues.add("UNKNOWN_GROUP_VALUE");
            if(selected.stream().anyMatch(m->!value.equals(m.get("onState")))||!value.equals("Off")&&selected.isEmpty()||value.equals("Off")&&!selected.isEmpty())issues.add("VALUE_APPEARANCE_MISMATCH");
            if(!unison&&selected.size()>1)issues.add("MULTIPLE_RADIO_SELECTIONS");
            if(unison&&entries.stream().anyMatch(m->(value.equals(m.get("onState"))&&!value.equals("Off"))!=Boolean.TRUE.equals(m.get("selected"))))issues.add("UNISON_STATE_MISMATCH");
            for(Map<String,Object> m:entries){@SuppressWarnings("unchecked") List<String> all=(List<String>)m.get("stateIssues");all.addAll(issues);}
        }else{
            COSBase rawOpt=inherited(field,COSName.OPT);require(rawOpt instanceof COSArray&&((COSArray)rawOpt).size()<=4096,"Choice options missing or excessive");COSArray opt=(COSArray)rawOpt;List<Map<String,String>> options=new ArrayList<>();
            for(int i=0;i<opt.size();i++){COSBase v=opt.getObject(i);String export,display;if(v instanceof COSArray pair){require(pair.size()==2,"Invalid choice option pair");export=text(pair.getObject(0));display=text(pair.getObject(1));}else{export=text(v);display=export;}Map<String,String> pair=new LinkedHashMap<>();pair.put("exportValue",export);pair.put("displayValue",display);options.add(pair);}
            COSBase rawValue=inherited(field,COSName.V);List<String> values=new ArrayList<>();if(rawValue instanceof COSArray array){require(array.size()<=4096,"Excessive choice values");for(int i=0;i<array.size();i++)values.add(text(array.getObject(i)));}else if(rawValue!=null)values.add(text(rawValue));
            List<Integer> indices=new ArrayList<>();List<String> issues=new ArrayList<>();COSBase rawI=field.getDictionaryObject(COSName.I);
            if(rawI!=null){require(rawI instanceof COSArray&&((COSArray)rawI).size()<=options.size(),"Invalid choice indices");COSArray array=(COSArray)rawI;for(int i=0;i<array.size();i++){int n=integer(array.getObject(i));require(n>=0&&n<options.size()&&(i==0||indices.get(i-1)<n),"Invalid choice selection order");indices.add(n);}Set<String> indexed=new HashSet<>();for(int i:indices)indexed.add(options.get(i).get("exportValue"));if(!indexed.equals(new HashSet<>(values)))issues.add("VALUE_INDEX_MISMATCH");}
            else for(String value:values){List<Integer> matches=new ArrayList<>();for(int i=0;i<options.size();i++)if(options.get(i).get("exportValue").equals(value))matches.add(i);if(matches.size()>1)issues.add("AMBIGUOUS_EXPORT_VALUE");else if(matches.isEmpty()&&!((flags&131072)!=0&&(flags&262144)!=0))issues.add("UNKNOWN_CHOICE_VALUE");else indices.addAll(matches);}
            indices=new ArrayList<>(new TreeSet<>(indices));if((flags&2097152)==0&&(values.size()>1||indices.size()>1))issues.add("MULTIPLE_SINGLE_CHOICE_VALUES");
            for(var m:output.values()){m.put("kind","choice");m.put("options",options);m.put("values",values);m.put("selectedIndices",indices);m.put("stateIssues",new ArrayList<>(new LinkedHashSet<>(issues)));}
        }
        return output;
    }
}
