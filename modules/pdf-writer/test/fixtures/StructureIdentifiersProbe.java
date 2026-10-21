import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.*;
class StructureIdentifiersProbe {
 static PDStructureElement add(String role,PDStructureNode parent) {
  PDStructureElement e=new PDStructureElement(role,parent);
  if(parent instanceof PDStructureTreeRoot) ((PDStructureTreeRoot)parent).appendKid(e); else ((PDStructureElement)parent).appendKid(e);
  return e;
 }
 public static void main(String[] args)throws Exception {
  for(String mode:List.of("valid","missing","duplicate","wrong-type","wrong-table","deep")) {
   PDStructureTreeRoot root=new PDStructureTreeRoot(); PDStructureElement document=add("Document",root), table=add("Table",document);
   PDStructureElement th=add(mode.equals("wrong-type")?"P":"TH",table); th.getCOSObject().setString(COSName.ID,"header");
   PDStructureElement td=add("TD",mode.equals("wrong-table")?add("Table",document):table);
   if(mode.equals("duplicate")) add("TH",table).getCOSObject().setString(COSName.ID,"header");
   COSArray headers=new COSArray(); headers.add(new COSString(mode.equals("missing")?"absent":"header"));
   COSDictionary attrs=new COSDictionary(); attrs.setName(COSName.O,"Table"); attrs.setItem(COSName.getPDFName("Headers"),headers); td.getCOSObject().setItem(COSName.A,attrs);
   if(mode.equals("deep")) { PDStructureElement p=table; for(int i=0;i<140;i++) p=add("Div",p); }
   boolean accepted=true; try { StructureIdentifiers.install(root); } catch(IOException expected) { accepted=false; }
   if(accepted!=mode.equals("valid")) throw new IOException("Incorrect ID registry decision: "+mode);
   if(accepted && root.getCOSObject().getCOSDictionary(COSName.getPDFName("IDTree"))==null) throw new IOException("Missing IDTree");
  }
  System.out.println("6 ID registry cases passed");
 }
}
