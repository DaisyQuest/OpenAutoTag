import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.contentstream.PDContentStream;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;

/** Fixed monospaced geometry, with independent saved-byte and ParentTree walks. */
public class NativeCompoundProbe {
    static void emit(ContentStreamWriter out, String op, Object... operands) throws Exception {
        out.writeTokens(Arrays.asList(operands)); out.writeToken(Operator.getOperator(op));
    }
    static COSString str(PDFont font, String text) throws Exception { return new COSString(font.encode(text)); }
    static String decode(PDFont font, COSBase operand) throws Exception {
        var text = new StringBuilder();
        if (operand instanceof COSString s) {
            var in = new ByteArrayInputStream(s.getBytes());
            while (in.available()>0) text.append(font.toUnicode(font.readCode(in)));
        } else if (operand instanceof COSArray a) for (COSBase part:a) if (part instanceof COSString) text.append(decode(font,part));
        return text.toString();
    }
    static void scan(PDDocument doc, PDContentStream stream, PDResources resources, COSDictionary scope, int page) throws Exception {
        var pending = new ArrayList<COSBase>(); var mcids = new ArrayDeque<Integer>();
        PDFont font = resources.getFont(COSName.getPDFName("F"));
        for (Object token : new PDFStreamParser(stream).parse()) {
            if (!(token instanceof Operator op)) { pending.add((COSBase)token); continue; }
            String name = op.getName();
            if ("BDC".equals(name)) mcids.push(((COSDictionary)pending.get(1)).getInt(COSName.MCID,-1));
            if ("BMC".equals(name)) mcids.push(-1);
            if ("EMC".equals(name)) mcids.pop();
            if ("Do".equals(name) && resources.getXObject((COSName)pending.get(0)) instanceof PDFormXObject form)
                scan(doc,form,form.getResources(),form.getCOSObject(),page);
            if (Set.of("Tj","TJ","'","\"").contains(name)) {
                String owner = "-";
                if (!mcids.isEmpty() && mcids.peek()>=0) {
                    var array = (COSArray)doc.getDocumentCatalog().getStructureTreeRoot().getParentTree().getNumbers().get(scope.getInt(COSName.STRUCT_PARENTS)).getCOSObject();
                    owner = ((COSDictionary)array.getObject(mcids.peek())).getString(COSName.ID);
                }
                COSBase operand = pending.get(pending.size()-1);
                System.out.println(page+"\t"+decode(font,operand)+"\t"+owner);
            }
            pending.clear();
        }
    }
    public static void main(String[] args) throws Exception {
        System.setOut(new PrintStream(System.out,true,StandardCharsets.UTF_8));
        if ("create".equals(args[0])) {
            try (var doc = new PDDocument(); var input = new FileInputStream(args[2])) {
                var font = PDType0Font.load(doc,input,false);
                var resources = new PDResources(); resources.put(COSName.getPDFName("F"),font);
                var form = new PDFormXObject(doc); form.setBBox(PDRectangle.LETTER); form.setResources(resources);
                try (var bytes = form.getCOSObject().createOutputStream()) {
                    var out = new ContentStreamWriter(bytes);
                    emit(out,"BT"); emit(out,"Tf",COSName.getPDFName("F"),COSInteger.get(10)); emit(out,"Td",COSInteger.get(72),COSInteger.get(450));
                    emit(out,"Tj",str(font,"Unit: kg")); emit(out,"ET");
                }
                for (int rotation : List.of(0,90,180,270)) {
                    var page = new PDPage(PDRectangle.LETTER); page.setRotation(rotation); doc.addPage(page);
                    var pageResources = new PDResources(new COSDictionary(resources.getCOSObject()));
                    pageResources.put(COSName.getPDFName("Form"),form); page.setResources(pageResources);
                    var stream = new PDStream(doc);
                    try (var bytes = stream.createOutputStream()) {
                        var out = new ContentStreamWriter(bytes);
                        emit(out,"BT"); emit(out,"Tf",COSName.getPDFName("F"),COSInteger.get(10)); emit(out,"TL",COSInteger.get(24));
                        emit(out,"Td",COSInteger.get(72),COSInteger.get(720)); emit(out,"Tj",str(font,"Name: Ada"));
                        emit(out,"T*"); var array = new COSArray(); array.add(COSInteger.get(-200)); array.add(str(font,"Co"));
                        array.add(COSInteger.get(50)); array.add(str(font,"de: Bob")); array.add(COSInteger.get(120)); array.add(new COSString(new byte[0]));
                        emit(out,"TJ",array); emit(out,"'",str(font,"Date: May"));
                        emit(out,"\"",COSInteger.get(2),new COSFloat(.25f),str(font,"City: Rome"));
                        emit(out,"T*"); emit(out,"Tj",str(font,"After: Eve")); emit(out,"ET");
                        emit(out,"Do",COSName.getPDFName("Form"));
                    }
                    page.setContents(stream);
                }
                doc.save(args[1]);
            }
        } else try (var doc = Loader.loadPDF(new File(args[1]))) {
            for (int p=0;p<doc.getNumberOfPages();p++) scan(doc,doc.getPage(p),doc.getPage(p).getResources(),doc.getPage(p).getCOSObject(),p+1);
        }
    }
}
