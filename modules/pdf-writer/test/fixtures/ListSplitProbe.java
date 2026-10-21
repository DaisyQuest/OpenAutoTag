import java.io.File;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;
import org.apache.pdfbox.rendering.PDFRenderer;
public class ListSplitProbe extends PDFTextStripper {
    private final List<TextPosition> positions=new ArrayList<>();
    ListSplitProbe() throws Exception { super(); }
    @Override protected void processTextPosition(TextPosition p) { positions.add(p); super.processTextPosition(p); }
    public static void main(String[] args) throws Exception {
        if("create".equals(args[0])) {
            try(PDDocument doc=new PDDocument()) {
                PDPage page=new PDPage(PDRectangle.LETTER);doc.addPage(page);
                var font=PDType0Font.load(doc,new File(args[2]));
                String[] texts={"Measurements","Length","Width","1234","iv. First item","v. Second item"};
                float[][] positions={{72,680},{72,648},{252,648},{72,616},{72,480},{72,458}};
                try(var stream=new PDPageContentStream(doc,page)) {
                    for(int i=0;i<texts.length;i++){stream.beginText();stream.setFont(font,12);stream.newLineAtOffset(positions[i][0],positions[i][1]);stream.showText(texts[i]);stream.endText();}
                }
                doc.save(args[1]);
            }
            return;
        }
        try(PDDocument source=Loader.loadPDF(new File(args[0]));PDDocument saved=Loader.loadPDF(new File(args[1]))) {
            ListSplitProbe a=new ListSplitProbe(),b=new ListSplitProbe();
            a.getText(source);b.getText(saved);
            if(a.positions.size()!=b.positions.size())throw new AssertionError("Changed glyph count");
            for(int i=0;i<a.positions.size();i++) {
                TextPosition x=a.positions.get(i),y=b.positions.get(i);
                if(!x.getUnicode().equals(y.getUnicode())||Math.abs(x.getXDirAdj()-y.getXDirAdj())>.001||Math.abs(x.getYDirAdj()-y.getYDirAdj())>.001)
                    throw new AssertionError("Changed glyph or position at "+i);
            }
            var left=new PDFRenderer(source).renderImageWithDPI(0,150);var right=new PDFRenderer(saved).renderImageWithDPI(0,150);
            if(left.getWidth()!=right.getWidth()||left.getHeight()!=right.getHeight())throw new AssertionError("Changed page dimensions");
            int changed=0;
            for(int y=0;y<left.getHeight();y++)for(int x=0;x<left.getWidth();x++)if(left.getRGB(x,y)!=right.getRGB(x,y))changed++;
            if(changed!=0)throw new AssertionError("Changed rendered pixels: "+changed);
            System.out.println("Glyph positions and 150 DPI pixels unchanged");
        }
    }
}
