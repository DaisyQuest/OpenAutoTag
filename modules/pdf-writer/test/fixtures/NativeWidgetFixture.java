import java.io.*;import java.util.*;
import org.apache.pdfbox.Loader;import org.apache.pdfbox.cos.*;import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;import org.apache.pdfbox.pdmodel.interactive.form.*;
public class NativeWidgetFixture {
 static COSName name(String value){return COSName.getPDFName(value);}
 static List<String> rawExports(PDChoice field)throws IOException{
  COSArray options=field.getCOSObject().getCOSArray(COSName.OPT);List<String> values=new ArrayList<>();if(options==null)throw new IOException("Missing options");
  for(int i=0;i<options.size();i++){COSBase entry=options.getObject(i);if(entry instanceof COSArray pair)entry=pair.getObject(0);if(!(entry instanceof COSString))throw new IOException("Invalid export value");values.add(((COSString)entry).getString());}return values;
 }
 static void label(PDPageContentStream c,PDFont f,int y,String text)throws Exception{c.beginText();c.setFont(f,12);c.newLineAtOffset(72,y);c.showText(text);c.endText();}
 static PDAppearanceStream appearance(PDDocument d,PDFont f,String text,boolean checked)throws Exception{
  var ap=new PDAppearanceStream(d);ap.setBBox(new PDRectangle(140,24));ap.setResources(new PDResources());
  try(var c=new PDPageContentStream(d,ap)){c.setStrokingColor(.2f);c.addRect(1,1,138,22);c.stroke();if(checked){c.setNonStrokingColor(.15f);c.addRect(4,4,12,16);c.fill();}if(!text.isEmpty()){c.beginText();c.setFont(f,11);c.newLineAtOffset(20,8);c.showText(text);c.endText();}}
  return ap;
 }
 static PDAnnotationWidget widget(PDTerminalField field,PDPage page,int y)throws Exception{
  var w=new PDAnnotationWidget();w.setParent(field);w.setRectangle(new PDRectangle(y==700?150:175,y-6,140,24));w.setPage(page);w.setPrinted(true);page.getAnnotations().add(w);return w;
 }
 static void states(PDDocument doc,PDFont font,PDAnnotationWidget w,String value)throws Exception{
  COSDictionary normal=new COSDictionary();normal.setItem(name("Off"),appearance(doc,font,"",false));normal.setItem(name(value),appearance(doc,font,value,true));COSDictionary ap=new COSDictionary();ap.setItem(COSName.N,normal);w.getCOSObject().setItem(COSName.AP,ap);w.setAppearanceState("Off");
 }
 public static void main(String[]a)throws Exception{
  if(a[0].equals("select")){
   List<String> expected=new ArrayList<>();String state=null;List<String> exports;
   try(PDDocument d=Loader.loadPDF(new File(a[1]))){var form=d.getDocumentCatalog().getAcroForm(null);var field=form.getField(a[3]);
    if(field instanceof PDRadioButton radio){exports=radio.getExportValues();int index=Integer.parseInt(a[4]);radio.setValue(index);state=radio.getCOSObject().getNameAsString(COSName.V);expected.add(exports.get(index));}
    else{PDChoice choice=(PDChoice)field;exports=rawExports(choice);for(String index:a[4].split(","))expected.add(exports.get(Integer.parseInt(index)));if(choice.isMultiSelect())choice.setValue(expected);else choice.setValue(expected.get(0));}d.save(a[2]);
   }
   try(PDDocument d=Loader.loadPDF(new File(a[2]))){var field=d.getDocumentCatalog().getAcroForm(null).getField(a[3]);
    if(field instanceof PDRadioButton radio){if(!exports.equals(radio.getExportValues())||!state.equals(radio.getCOSObject().getNameAsString(COSName.V)))throw new IOException("Radio values changed during reopen");int checked=0;for(var w:radio.getWidgets()){String on=w.getCOSObject().getNameAsString(COSName.AS);if(!"Off".equals(on)){if(!state.equals(on))throw new IOException("Radio appearance/value mismatch");checked++;}}if(checked!=1)throw new IOException("Radio selection is not unique");}
    else{PDChoice choice=(PDChoice)field;if(!expected.equals(choice.getValue())||!exports.equals(rawExports(choice)))throw new IOException("Choice selection/export changed during reopen");}
   }System.out.println("Selected values and original exports survived save/reopen");return;
  }
  if(a[0].equals("encrypt")){
   try(PDDocument d=Loader.loadPDF(new File(a[1]))){var policy=new org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy("qa-owner","",new org.apache.pdfbox.pdmodel.encryption.AccessPermission());d.protect(policy);d.save(a[2]);}return;
  }
  if(a[0].equals("edit")){
   try(PDDocument d=Loader.loadPDF(new File(a[1]))){var form=d.getDocumentCatalog().getAcroForm();((PDTextField)form.getField("name")).setValue("José café 987");((PDCheckBox)form.getField("consent")).check();((PDRadioButton)form.getField("contact")).setValue("Phone");((PDComboBox)form.getField("state")).setValue("NY");if(form.getField("narrative") instanceof PDTextField narrative)narrative.setValue("Updated first line\nSecond line preserved");d.save(a[2]);}
   try(PDDocument d=Loader.loadPDF(new File(a[2]))){var f=d.getDocumentCatalog().getAcroForm();if(!"José café 987".equals(f.getField("name").getValueAsString())||!((PDCheckBox)f.getField("consent")).isChecked()||!"Phone".equals(f.getField("contact").getValueAsString())||!List.of("NY").equals(((PDComboBox)f.getField("state")).getValue()))throw new IOException("Widget interaction did not survive");if(f.getField("narrative") instanceof PDTextField narrative&&!"Updated first line\nSecond line preserved".equals(narrative.getValue()))throw new IOException("Multiline edit did not survive");}
   System.out.println("Text, checkbox, radio and choice values survived save/reopen");return;
  }
  try(PDDocument d=new PDDocument()){
   PDFont font=PDType0Font.load(d,new FileInputStream(a[2]),false);PDPage p=new PDPage(),q=new PDPage();d.addPage(p);d.addPage(q);
   try(var c=new PDPageContentStream(d,p)){label(c,font,750,"Native widget preservation");label(c,font,700,"Full name:");label(c,font,640,"Consent:");label(c,font,580,"Email contact:");label(c,font,520,"Phone contact:");label(c,font,460,"State:");label(c,font,400,"Reset form:");}
   try(var c=new PDPageContentStream(d,q)){label(c,font,750,"Repeated field on second page");label(c,font,700,"Full name:");}
   PDAcroForm form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(name("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
   PDTextField text=new PDTextField(form);text.setPartialName("name");text.setAlternateFieldName("Full name");var w1=widget(text,p,700);var w2=widget(text,q,700);text.setWidgets(List.of(w1,w2));form.getFields().add(text);text.setValue("Original café");
   PDCheckBox check=new PDCheckBox(form);check.setPartialName("consent");check.setAlternateFieldName("Consent");var wc=widget(check,p,640);check.setWidgets(List.of(wc));states(d,font,wc,"Yes");form.getFields().add(check);check.unCheck();
   boolean choiceMode=a.length>3&&a[3].equals("choice-semantics");
   PDRadioButton radio=new PDRadioButton(form);radio.setPartialName("contact");radio.setAlternateFieldName("Preferred contact method");var email=widget(radio,p,580);var phone=widget(radio,p,520);radio.setWidgets(List.of(email,phone));states(d,font,email,choiceMode?"0":"Email");states(d,font,phone,choiceMode?"1":"Phone");form.getFields().add(radio);if(choiceMode){radio.setExportValues(List.of("notify.email","notify.phone"));radio.setValue(0);}else radio.setValue("Email");
   PDComboBox combo=new PDComboBox(form);combo.setPartialName("state");combo.setAlternateFieldName("State");var ws=widget(combo,p,460);combo.setWidgets(List.of(ws));if(choiceMode)combo.setOptions(List.of("CA","NY"),List.of("California","New York"));else combo.setOptions(List.of("CA","NY"));form.getFields().add(combo);combo.setValue("CA");
   if(choiceMode){try(var c=new PDPageContentStream(d,q,PDPageContentStream.AppendMode.APPEND,true)){label(c,font,500,"Topics:");}PDListBox topics=new PDListBox(form);topics.setPartialName("topics");topics.setAlternateFieldName("Topics");topics.setMultiSelect(true);var wt=widget(topics,q,500);wt.setRectangle(new PDRectangle(175,410,140,100));topics.setWidgets(List.of(wt));topics.setOptions(List.of("SCI","ART","TECH"),List.of("Science","Arts","Technology"));form.getFields().add(topics);topics.setValue(List.of("SCI","TECH"));}
   PDPushButton button=new PDPushButton(form);button.setPartialName("reset");button.setAlternateFieldName("Reset form");var wb=widget(button,p,400);button.setWidgets(List.of(wb));var ap=new PDAppearanceDictionary();ap.setNormalAppearance(appearance(d,font,"Reset",false));wb.setAppearance(ap);COSDictionary action=new COSDictionary();action.setName(COSName.S,"ResetForm");COSArray targets=new COSArray();targets.add(new COSString("name"));action.setItem(COSName.FIELDS,targets);wb.getCOSObject().setItem(COSName.A,action);form.getFields().add(button);
   PDTextField hidden=new PDTextField(form);hidden.setPartialName("hidden");hidden.setAlternateFieldName("Internal identifier");var wh=widget(hidden,q,600);wh.setHidden(true);hidden.setWidgets(List.of(wh));form.getFields().add(hidden);hidden.setValue("Keep unchanged");
   COSDictionary aa=new COSDictionary(),validation=new COSDictionary();validation.setName(COSName.S,"JavaScript");validation.setString(name("JS"),"event.rc = true;");aa.setItem(name("V"),validation);text.getCOSObject().setItem(COSName.AA,aa);
   if(a.length>3&&a[3].equals("navigation")){
    try(var c=new PDPageContentStream(d,p,PDPageContentStream.AppendMode.APPEND,true)){label(c,font,340,"Date:");}
    try(var c=new PDPageContentStream(d,q,PDPageContentStream.AppendMode.APPEND,true)){label(c,font,540,"Describe the circumstances");label(c,font,510,"requiring further assistance:");label(c,font,350,"Read-only reference:");label(c,font,300,"Noninteractive explanatory text.");}
    for(String part:List.of("month","day")){PDTextField f=new PDTextField(form);f.setPartialName(part);f.setAlternateFieldName("Date "+part);var w=widget(f,p,340);w.setRectangle(new PDRectangle(part.equals("day")?175:250,part.equals("day")?334:334.13f,60,24));f.setWidgets(List.of(w));form.getFields().add(f);f.setValue(part.equals("day")?"23":"10");}
    PDTextField narrative=new PDTextField(form);narrative.setPartialName("narrative");narrative.setAlternateFieldName("Describe the circumstances requiring further assistance");narrative.setMultiline(true);var wn=widget(narrative,q,440);wn.setRectangle(new PDRectangle(72,410,340,75));narrative.setWidgets(List.of(wn));form.getFields().add(narrative);narrative.setValue("Original explanation");
    for(String type:List.of("readonly","noview","empty")){PDTextField f=new PDTextField(form);f.setPartialName(type);f.setAlternateFieldName(type.equals("readonly")?"Read-only reference":"Internal "+type);var w=widget(f,q,type.equals("readonly")?350:220);if(type.equals("readonly"))w.setRectangle(new PDRectangle(220,344,140,24));if(type.equals("noview"))w.setNoView(true);if(type.equals("empty"))w.setRectangle(new PDRectangle(175,180,0,24));f.setWidgets(List.of(w));form.getFields().add(f);f.setValue("Keep unchanged");if(type.equals("readonly"))f.setReadOnly(true);}
    List<PDField> reversed=new ArrayList<>(form.getFields());Collections.reverse(reversed);form.setFields(reversed);for(PDPage page:List.of(p,q)){var annots=new ArrayList<>(page.getAnnotations());Collections.reverse(annots);page.setAnnotations(annots);}
   }
   if(a.length>3&&a[3].equals("missing-name"))text.getCOSObject().removeItem(COSName.TU);
   d.save(a[1]);
  }
 }
}
