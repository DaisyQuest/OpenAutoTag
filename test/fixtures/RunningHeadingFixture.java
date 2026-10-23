import java.io.File;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.*;

/** Fixed source-page oracle, independent of inference and tag-tree generation. */
public class RunningHeadingFixture {
    static void line(PDPageContentStream out, PDFont font, float size, float x, float top, String text) throws Exception {
        out.beginText(); out.setFont(font,size); out.newLineAtOffset(x,792-top-size); out.showText(text); out.endText();
    }
    public static void main(String[] args) throws Exception {
        try(var doc=new PDDocument()) {
            var regular=PDType0Font.load(doc,new File(args[1]));
            var bold=PDType0Font.load(doc,new File(args[2]));
            var other=PDType0Font.load(doc,new File(args[3]));
            doc.getDocumentInformation().setTitle("Running content and heading regression");
            for(int p=1;p<=4;p++) {
                var page=new PDPage(PDRectangle.LETTER);doc.addPage(page);
                try(var out=new PDPageContentStream(doc,page)) {
                    line(out,regular,10,50,20,"Mission reference");
                    line(out,bold,18,50,70,"SUPPLEMENTAL AFFIRMATION");
                    line(out,other,18,50,90.7f,"IN SUPPORT OF ORDER TO SHOW CAUSE");
                    line(out,bold,14,50,130,"Instructions for applicants");
                    line(out,bold,12,50,160,"Details");
                    line(out,regular,12,50,200,"3.14 meters");
                    line(out,regular,12,50,220,"2026.10.23");
                    line(out,regular,12,50,250,"1. First action");
                    line(out,regular,12,50,290,"Useful body text survives.");
                    line(out,regular,10,p%2==0?480:50,755+p,"Page "+p+" of 4");
                }
            }
            doc.save(args[0]);
        }
    }
}
