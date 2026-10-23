import java.io.*;import java.util.*;
import org.apache.pdfbox.Loader;import org.apache.pdfbox.cos.*;import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;import org.apache.pdfbox.pdmodel.interactive.form.*;
public class NativeWidgetFixture {
 static COSName name(String value){return COSName.getPDFName(value);}
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
  if(a[0].equals("encrypt")){
   try(PDDocument d=Loader.loadPDF(new File(a[1]))){var policy=new org.apache.pdfbox.pdmodel.encryption.StandardProtectionPolicy("qa-owner","",new org.apache.pdfbox.pdmodel.encryption.AccessPermission());d.protect(policy);d.save(a[2]);}return;
  }
  if(a[0].equals("edit")){
   try(PDDocument d=Loader.loadPDF(new File(a[1]))){var form=d.getDocumentCatalog().getAcroForm();((PDTextField)form.getField("name")).setValue("José café 987");((PDCheckBox)form.getField("consent")).check();((PDRadioButton)form.getField("contact")).setValue("Phone");((PDComboBox)form.getField("state")).setValue("NY");d.save(a[2]);}
   try(PDDocument d=Loader.loadPDF(new File(a[2]))){var f=d.getDocumentCatalog().getAcroForm();if(!"José café 987".equals(f.getField("name").getValueAsString())||!((PDCheckBox)f.getField("consent")).isChecked()||!"Phone".equals(f.getField("contact").getValueAsString())||!List.of("NY").equals(((PDComboBox)f.getField("state")).getValue()))throw new IOException("Widget interaction did not survive");}
   System.out.println("Text, checkbox, radio and choice values survived save/reopen");return;
  }
  try(PDDocument d=new PDDocument()){
   PDFont font=PDType0Font.load(d,new FileInputStream(a[2]),false);PDPage p=new PDPage(),q=new PDPage();d.addPage(p);d.addPage(q);
   try(var c=new PDPageContentStream(d,p)){label(c,font,750,"Native widget preservation");label(c,font,700,"Full name:");label(c,font,640,"Consent:");label(c,font,580,"Email contact:");label(c,font,520,"Phone contact:");label(c,font,460,"State:");label(c,font,400,"Reset form:");}
   try(var c=new PDPageContentStream(d,q)){label(c,font,750,"Repeated field on second page");label(c,font,700,"Full name:");}
   PDAcroForm form=new PDAcroForm(d);d.getDocumentCatalog().setAcroForm(form);PDResources resources=new PDResources();resources.put(name("F1"),font);form.setDefaultResources(resources);form.setDefaultAppearance("/F1 12 Tf 0 g");
   PDTextField text=new PDTextField(form);text.setPartialName("name");text.setAlternateFieldName("Full name");var w1=widget(text,p,700);var w2=widget(text,q,700);text.setWidgets(List.of(w1,w2));form.getFields().add(text);text.setValue("Original café");
   PDCheckBox check=new PDCheckBox(form);check.setPartialName("consent");check.setAlternateFieldName("Consent");var wc=widget(check,p,640);check.setWidgets(List.of(wc));states(d,font,wc,"Yes");form.getFields().add(check);check.unCheck();
   PDRadioButton radio=new PDRadioButton(form);radio.setPartialName("contact");radio.setAlternateFieldName("Preferred contact method");var email=widget(radio,p,580);var phone=widget(radio,p,520);radio.setWidgets(List.of(email,phone));states(d,font,email,"Email");states(d,font,phone,"Phone");form.getFields().add(radio);radio.setValue("Email");
   PDComboBox combo=new PDComboBox(form);combo.setPartialName("state");combo.setAlternateFieldName("State");var ws=widget(combo,p,460);combo.setWidgets(List.of(ws));combo.setOptions(List.of("CA","NY"));form.getFields().add(combo);combo.setValue("CA");
   PDPushButton button=new PDPushButton(form);button.setPartialName("reset");button.setAlternateFieldName("Reset form");var wb=widget(button,p,400);button.setWidgets(List.of(wb));var ap=new PDAppearanceDictionary();ap.setNormalAppearance(appearance(d,font,"Reset",false));wb.setAppearance(ap);COSDictionary action=new COSDictionary();action.setName(COSName.S,"ResetForm");COSArray targets=new COSArray();targets.add(new COSString("name"));action.setItem(COSName.FIELDS,targets);wb.getCOSObject().setItem(COSName.A,action);form.getFields().add(button);
   PDTextField hidden=new PDTextField(form);hidden.setPartialName("hidden");hidden.setAlternateFieldName("Internal identifier");var wh=widget(hidden,q,600);wh.setHidden(true);hidden.setWidgets(List.of(wh));form.getFields().add(hidden);hidden.setValue("Keep unchanged");
   COSDictionary aa=new COSDictionary(),validation=new COSDictionary();validation.setName(COSName.S,"JavaScript");validation.setString(name("JS"),"event.rc = true;");aa.setItem(name("V"),validation);text.getCOSObject().setItem(COSName.AA,aa);
   if(a.length>3&&a[3].equals("missing-name"))text.getCOSObject().removeItem(COSName.TU);
   d.save(a[1]);
  }
 }
}
