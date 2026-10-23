import java.io.*;
import java.util.*;
import java.awt.image.BufferedImage;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.pdmodel.interactive.form.*;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.text.*;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import java.awt.geom.Point2D;

/** Identical display layouts expressed with independent source-page transforms. */
public class DisplayGeometryProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static Matrix inverse(PDPage p){var b=p.getCropBox();float s=1/p.getUserUnit();return switch(p.getRotation()){
        case 90->new Matrix(0,s,-s,0,b.getUpperRightX(),b.getLowerLeftY());
        case 180->new Matrix(-s,0,0,-s,b.getUpperRightX(),b.getUpperRightY());
        case 270->new Matrix(0,-s,s,0,b.getLowerLeftX(),b.getUpperRightY());
        default->new Matrix(s,0,0,s,b.getLowerLeftX(),b.getLowerLeftY());};}
    static void text(PDPageContentStream c,PDFont font,float size,float x,float top,String text)throws Exception{
        c.beginText();c.setFont(font,size);c.newLineAtOffset(x,792-top);c.showText(text);c.endText();
    }
    static void create(String file,String fontFile,int count)throws Exception{
        try(var doc=new PDDocument();var in=new FileInputStream(fontFile)){
            doc.setVersion(1.7f);var font=PDType0Font.load(doc,in,false);
            var form=new PDAcroForm(doc);var fr=new PDResources();fr.put(COSName.getPDFName("F"),font);form.setDefaultResources(fr);doc.getDocumentCatalog().setAcroForm(form);
            var bitmap=new BufferedImage(2,2,BufferedImage.TYPE_INT_RGB);bitmap.setRGB(0,0,0x0044AA);bitmap.setRGB(1,0,0x22AA55);bitmap.setRGB(0,1,0xFFBB33);bitmap.setRGB(1,1,0xBB2277);var image=LosslessFactory.createFromImage(doc,bitmap);
            for(int i=0;i<count;i++){
                int rotation=(i%4)*90;float unit=i<24?(i/4%2==0?1:2):(i%2==0?.5f:2);
                float left=i<24?new float[]{0,47,-83}[i/8]:-43,bottom=i<24?new float[]{0,71,-59}[i/8]:67;
                float width=(rotation%180==0?612:792)/unit,height=(rotation%180==0?792:612)/unit;
                var p=new PDPage(new PDRectangle(left-20,bottom-30,width+40,height+60));p.setCropBox(new PDRectangle(left,bottom,width,height));p.setRotation(rotation);p.setUserUnit(unit);doc.addPage(p);
                try(var c=new PDPageContentStream(doc,p)){
                    c.transform(inverse(p));
                    text(c,font,21,200,211,"Geometry "+(char)('A'+i));
                    text(c,font,14,217,260,"Observing the magnetic Sun");
                    for(int row=0;row<4;row++)for(int column:new int[]{1,0}){
                        String line=row==1?"Shared label.":(column==0?"Left":"Right")+" column has a long line of continuous prose.";
                        text(c,font,10,column==0?63:318,281+row*14,line);
                    }
                    c.drawImage(image,480,100,40,30);
                    // A 2x2 ruling around the last two prose rows exercises
                    // the separate vector-table diagnostic coordinate path.
                    for(float x:new float[]{60,310,560}){c.moveTo(x,792-295);c.lineTo(x,792-337);}
                    for(float y:new float[]{295,316,337}){c.moveTo(60,792-y);c.lineTo(560,792-y);}c.stroke();
                    if(i>=24)text(c,font,10,63,500,"Field label:");
                }
                if(i>=24){
                    var field=new PDTextField(form);field.setPartialName("field"+i);field.setAlternateFieldName("Field label");field.setDefaultAppearance("/F "+(10/unit)+" Tf 0 g");form.getFields().add(field);
                    var a=inverse(p).transformPoint(150,792-515);var b=inverse(p).transformPoint(290,792-490);
                    var rect=new PDRectangle(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(a.x-b.x),Math.abs(a.y-b.y));
                    var widget=field.getWidgets().get(0);widget.setRectangle(rect);widget.setPage(p);widget.setPrinted(true);p.getAnnotations().add(widget);field.setValue("Keep "+i);
                }
            }
            doc.save(file);
        }
    }
    static class Glyphs extends PDFTextStripper{
        List<String> values=new ArrayList<>();Glyphs()throws IOException{}
        @Override public void beginMarkedContentSequence(COSName tag,COSDictionary props){}
        @Override public void endMarkedContentSequence(){}
        @Override protected void processTextPosition(TextPosition t){values.add(t.getUnicode()+"/"+Arrays.toString(t.getCharacterCodes())+"/"+t.getX()+"/"+t.getY()+"/"+t.getWidth());super.processTextPosition(t);}
    }
    static class OwnedGlyphs extends PDFTextStripper {
        final Map<COSDictionary,Map<Integer,List<TextPosition>>> pages=new IdentityHashMap<>();
        Map<Integer,List<TextPosition>> current;Deque<Integer> scopes=new ArrayDeque<>();
        OwnedGlyphs()throws IOException{}
        @Override public void processPage(PDPage p)throws IOException {current=new HashMap<>();pages.put(p.getCOSObject(),current);scopes.clear();super.processPage(p);}
        @Override public void beginMarkedContentSequence(COSName tag,COSDictionary props){scopes.push(props==null?-1:props.getInt(COSName.MCID,-1));}
        @Override public void endMarkedContentSequence(){scopes.pop();}
        @Override protected void processTextPosition(TextPosition p){for(int id:scopes)if(id>=0){current.computeIfAbsent(id,k->new ArrayList<>()).add(p);break;}super.processTextPosition(p);}
    }
    static void walk(COSBase value,COSDictionary page,OwnedGlyphs owned,Map<COSDictionary,List<TextPosition>> ordered,Set<String> seen,Map<COSDictionary,Integer> numbers){
        if(value instanceof COSObject o)value=o.getObject();
        if(value instanceof COSArray a){for(COSBase v:a)walk(v,page,owned,ordered,seen,numbers);return;}
        if(value instanceof COSDictionary d){
            if(d.getDictionaryObject(COSName.PG) instanceof COSDictionary p)page=p;
            if(d.containsKey(COSName.MCID)){check(!d.containsKey(COSName.getPDFName("Stm")),"Fixture uses page content only");value=d.getDictionaryObject(COSName.MCID);}
            else {walk(d.getDictionaryObject(COSName.K),page,owned,ordered,seen,numbers);return;}
        }
        if(value instanceof COSInteger id){
            check(page!=null&&numbers.containsKey(page),"Saved reference page");
            check(seen.add(numbers.get(page)+":"+id.intValue()),"One saved owner per MCID");
            ordered.computeIfAbsent(page,k->new ArrayList<>()).addAll(owned.pages.get(page).getOrDefault(id.intValue(),List.of()));
        }
    }
    static String joined(List<TextPosition> positions){StringBuilder s=new StringBuilder();for(var p:positions)s.append(p.getUnicode());return s.toString();}
    static void savedOrder(PDDocument doc)throws Exception {
        var owned=new OwnedGlyphs();owned.getText(doc);var ordered=new IdentityHashMap<COSDictionary,List<TextPosition>>();var numbers=new IdentityHashMap<COSDictionary,Integer>();
        for(int i=0;i<doc.getNumberOfPages();i++)numbers.put(doc.getPage(i).getCOSObject(),i);
        walk(doc.getDocumentCatalog().getStructureTreeRoot().getCOSObject().getDictionaryObject(COSName.K),null,owned,ordered,new HashSet<>(),numbers);
        for(int i=0;i<24;i++){
            var page=doc.getPage(i);var positions=ordered.get(page.getCOSObject());check(positions!=null,"Saved text on page "+i);
            StringBuilder expected=new StringBuilder("Geometry "+(char)('A'+i)+"Observing the magnetic Sun");
            for(String side:List.of("Left","Right"))for(int row=0;row<4;row++)expected.append(row==1?"Shared label.":side+" column has a long line of continuous prose.");
            check(joined(positions).equals(expected.toString()),"Saved column order/full text page "+i+": "+joined(positions));
            // Equal strings must still belong to their own spatial column.
            int offset=("Geometry "+(char)('A'+i)+"Observing the magnetic Sun").length();
            for(int column=0;column<2;column++)for(int row=0;row<4;row++){
                var first=positions.get(offset);check(Math.abs(first.getX()*page.getUserUnit()-(column==0?63:318))<.025,"Duplicate label column ownership "+i);
                check(Math.abs(first.getY()*page.getUserUnit()-(281+row*14))<.025,"Saved baseline "+i);
                offset+=(row==1?"Shared label.":(column==0?"Left":"Right")+" column has a long line of continuous prose.").length();
            }
        }
    }
    static void verify(String before,String after)throws Exception{
        try(var a=Loader.loadPDF(new File(before));var b=Loader.loadPDF(new File(after))){
            savedOrder(b);
            check(a.getNumberOfPages()==b.getNumberOfPages(),"Page count");var x=new Glyphs();var y=new Glyphs();x.getText(a);y.getText(b);check(x.values.equals(y.values),"Source glyphs and positions");
            var ar=new PDFRenderer(a);var br=new PDFRenderer(b);
            for(int i=0;i<a.getNumberOfPages();i++){
                var p=a.getPage(i);var q=b.getPage(i);check(Arrays.equals(p.getMediaBox().getCOSArray().toFloatArray(),q.getMediaBox().getCOSArray().toFloatArray()),"MediaBox");check(Arrays.equals(p.getCropBox().getCOSArray().toFloatArray(),q.getCropBox().getCOSArray().toFloatArray()),"CropBox");check(p.getRotation()==q.getRotation()&&p.getUserUnit()==q.getUserUnit(),"Rotate/UserUnit");
                // PDFBox's requested DPI is relative to raw units. Use the
                // source multiplier to compare every page at 96 physical DPI.
                var l=ar.renderImageWithDPI(i,96*p.getUserUnit());var r=br.renderImageWithDPI(i,96*q.getUserUnit());
                check(l.getWidth()==r.getWidth()&&l.getHeight()==r.getHeight(),"Rendered size "+i);
                check(Arrays.equals(l.getRGB(0,0,l.getWidth(),l.getHeight(),null,0,l.getWidth()),r.getRGB(0,0,r.getWidth(),r.getHeight(),null,0,r.getWidth())),"Pixels "+i);
            }
            var af=a.getDocumentCatalog().getAcroForm();var bf=b.getDocumentCatalog().getAcroForm();check(af.getFields().size()==4&&bf.getFields().size()==4,"Four fields preserved");
            for(var field:af.getFields()){var saved=bf.getField(field.getFullyQualifiedName());check(saved!=null&&saved.getValueAsString().equals(field.getValueAsString()),"Field value");check(Arrays.equals(field.getWidgets().get(0).getRectangle().getCOSArray().toFloatArray(),saved.getWidgets().get(0).getRectangle().getCOSArray().toFloatArray()),"Widget rectangle");
                ((PDTextField)field).setValue("Édit "+field.getPartialName());((PDTextField)saved).setValue("Édit "+field.getPartialName());}
            var filledSource=new ByteArrayOutputStream();var filledCandidate=new ByteArrayOutputStream();a.save(filledSource);b.save(filledCandidate);
            try(var fa=Loader.loadPDF(filledSource.toByteArray());var fb=Loader.loadPDF(filledCandidate.toByteArray())){
                for(int i=24;i<28;i++){var l=new PDFRenderer(fa).renderImageWithDPI(i,96*fa.getPage(i).getUserUnit());var r=new PDFRenderer(fb).renderImageWithDPI(i,96*fb.getPage(i).getUserUnit());check(Arrays.equals(l.getRGB(0,0,l.getWidth(),l.getHeight(),null,0,l.getWidth()),r.getRGB(0,0,r.getWidth(),r.getHeight(),null,0,r.getWidth())),"Filled/saved/reopened field pixels "+i);}
            }
            System.out.println("28 display geometries, source glyphs, 96 DPI pixels and four form fields preserved");
        }
    }
    static class BitmapPlacement extends PDFGraphicsStreamEngine {
        int images=0;
        BitmapPlacement(PDPage page){super(page);}
        public void drawImage(org.apache.pdfbox.pdmodel.graphics.image.PDImage image){
            images++;var actual=getGraphicsState().getCurrentTransformationMatrix();var expected=inverse(getPage());
            for(float x:new float[]{0,1})for(float y:new float[]{0,1}){
                var a=actual.transformPoint(x,y);var e=expected.transformPoint(x*612,y*792);
                check(a.distance(e)<.002,"Raster image corner in original page coordinates");
            }
        }
        public void appendRectangle(Point2D a,Point2D b,Point2D c,Point2D d){} public void clip(int rule){}
        public void moveTo(float x,float y){} public void lineTo(float x,float y){} public void curveTo(float a,float b,float c,float d,float e,float f){}
        public Point2D getCurrentPoint(){return new Point2D.Float();} public void closePath(){} public void endPath(){}
        public void strokePath(){} public void fillPath(int rule){} public void fillAndStrokePath(int rule){} public void shadingFill(COSName name){}
    }
    static void raster(String before,String after,boolean redacted,boolean standalone)throws Exception{
        try(var a=Loader.loadPDF(new File(before));var b=Loader.loadPDF(new File(after))){
            check(a.getNumberOfPages()==24&&b.getNumberOfPages()==24,"Raster fixture page count");
            var glyphs=new OwnedGlyphs();glyphs.getText(b);
            for(int i=0;i<24;i++){
                var p=a.getPage(i);var q=b.getPage(i);check(p.getUserUnit()==q.getUserUnit()&&p.getRotation()==q.getRotation(),"Raster page scale/rotation");
                var l=new PDFRenderer(a).renderImageWithDPI(i,standalone?200:144);var r=new PDFRenderer(b).renderImageWithDPI(i,standalone?200:144);
                check(l.getWidth()==r.getWidth()&&l.getHeight()==r.getHeight(),"Raster display dimensions");
                if(redacted){
                    double sx=l.getWidth()/612.0,sy=l.getHeight()/792.0;
                    // Full colored-image region was explicitly selected for redaction.
                    int x=(int)Math.floor(480*sx),y=(int)Math.floor(662*sy),w=(int)Math.ceil(40*sx),h=(int)Math.ceil(30*sy);
                    var g=l.createGraphics();g.setColor(java.awt.Color.BLACK);g.fillRect(x,y,w,h);g.dispose();
                }
                int[] left=l.getRGB(0,0,l.getWidth(),l.getHeight(),null,0,l.getWidth()),right=r.getRGB(0,0,r.getWidth(),r.getHeight(),null,0,r.getWidth());
                if(standalone){
                    var placement=new BitmapPlacement(q);placement.processPage(q);check(placement.images==1,"Exactly one placed raster bitmap");
                    BufferedImage embedded=null;for(var name:q.getResources().getXObjectNames())if(q.getResources().getXObject(name) instanceof org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject img)embedded=img.getImage();
                    check(embedded!=null&&embedded.getWidth()==l.getWidth()&&embedded.getHeight()==l.getHeight(),"Standalone embedded bitmap dimensions");
                    check(Arrays.equals(left,embedded.getRGB(0,0,embedded.getWidth(),embedded.getHeight(),null,0,embedded.getWidth())),"Standalone redacted bitmap pixels exactly preserved "+i);
                }
                long different=0,totalError=0;for(int k=0;k<left.length;k++){if(left[k]!=right[k])different++;for(int shift:new int[]{0,8,16})totalError+=Math.abs(((left[k]>>shift)&255)-((right[k]>>shift)&255));}
                // 200 DPI is fractional (25/9 pixels per point); replaying the
                // exact stored bitmap adds interpolation at edge pixels.
                if(!standalone)check(different/(double)left.length<.002&&totalError/(3.0*left.length)<.2,"Raster resampling difference page "+i+": "+different/(double)left.length+", mean="+totalError/(3.0*left.length));
                if(!standalone){var positions=glyphs.pages.get(q.getCOSObject()).values().stream().flatMap(List::stream).toList();
                    check(positions.stream().anyMatch(t->"G".equals(t.getUnicode())&&Math.abs(t.getX()*q.getUserUnit()-200)<.025&&Math.abs(t.getY()*q.getUserUnit()-211)<.025),"Raster title overlay position "+i);}
            }
            System.out.println("24 raster display transforms"+(standalone?" and exact stored bitmaps":" and overlay positions")+" verified"+(redacted?" with display-coordinate redactions":""));
        }
    }
    public static void main(String[] args)throws Exception{
        switch(args[0]){case "create"->create(args[1],args[2],args.length>3?24:28);case "verify-raster"->raster(args[1],args[2],args.length>3,args.length>3&&"standalone".equals(args[3]));default->verify(args[1],args[2]);}
    }
}
