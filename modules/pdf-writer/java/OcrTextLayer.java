import java.io.IOException;
import java.io.ByteArrayOutputStream;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.documentinterchange.markedcontent.PDPropertyList;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.graphics.state.RenderingMode;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;

/** Appends real tagged text without repainting the source image or native text. */
final class OcrTextLayer {
    record Line(String tagId, String type, int pageNumber, String text, double[] quad) {}
    record Run(PDFont font, String text, byte[] encoded, double advance) {}
    static final class Fonts {
        private final List<PDFont> fonts;
        private final Map<Integer,PDFont> coverage=new HashMap<>();
        private final Map<Line,List<Run>> planned=new IdentityHashMap<>();
        Fonts(List<PDFont> fonts) { this.fonts=List.copyOf(fonts); }
        private PDFont select(int cp) throws IOException {
            if(coverage.containsKey(cp))return coverage.get(cp);
            for(PDFont font:fonts)try {
                font.encode(new String(Character.toChars(cp)));coverage.put(cp,font);return font;
            } catch(IllegalArgumentException unavailable) { /* Try the next bundled font. */ }
            throw new IOException("OCR font cannot encode U+"+Integer.toHexString(cp).toUpperCase(Locale.ROOT));
        }
        private Run run(PDFont font,String text) throws IOException {
            return new Run(font,text,font.encode(text),font.getStringWidth(text)/1000.0);
        }
        List<Run> runs(Line line) throws IOException {
            if(planned.containsKey(line))return planned.get(line);
            List<Run> runs=new ArrayList<>();PDFont previous=null;StringBuilder text=new StringBuilder();
            for(int cp:line.text().codePoints().toArray()) {
                PDFont font=select(cp);
                if(previous!=null && previous!=font){runs.add(run(previous,text.toString()));text.setLength(0);}
                previous=font;text.appendCodePoint(cp);
            }
            if(previous!=null)runs.add(run(previous,text.toString()));
            planned.put(line,List.copyOf(runs));return planned.get(line);
        }
    }

    static double[] point(PDPage page, double x, double y) throws IOException {
        var b = page.getCropBox(); double u = page.getUserUnit();
        if (!Double.isFinite(u) || u <= 0) throw new IOException("Invalid OCR page UserUnit");
        return switch (page.getRotation()) {
            case 0 -> new double[]{b.getLowerLeftX()+x/u, b.getUpperRightY()-y/u};
            case 90 -> new double[]{b.getLowerLeftX()+y/u, b.getLowerLeftY()+x/u};
            case 180 -> new double[]{b.getUpperRightX()-x/u, b.getLowerLeftY()+y/u};
            case 270 -> new double[]{b.getUpperRightX()-y/u, b.getUpperRightY()-x/u};
            default -> throw new IOException("Unsupported OCR page rotation");
        };
    }

    static void validate(PDPage page, Line line, Fonts fonts) throws IOException {
        double[] q = line.quad(); var b = page.getCropBox(); boolean side = page.getRotation()%180 != 0;
        double w=(side?b.getHeight():b.getWidth())*page.getUserUnit(), h=(side?b.getWidth():b.getHeight())*page.getUserUnit();
        if (q.length != 8 || line.text().isBlank() || line.text().length()>32768) throw new IOException("Invalid OCR line");
        for (int i=0;i<8;i++) if (!Double.isFinite(q[i]) || q[i]<-0.002 || q[i]>(i%2==0?w:h)+0.002)
            throw new IOException("OCR quadrilateral is outside the page");
        double ax=q[2]-q[0], ay=q[3]-q[1], bx=q[6]-q[0], by=q[7]-q[1];
        if (Math.hypot(ax,ay)<0.001 || Math.hypot(bx,by)<0.001 || ax*by-ay*bx<=0 ||
            Math.abs(q[4]-q[0]-ax-bx)>0.002 || Math.abs(q[5]-q[1]-ay-by)>0.002 ||
            Math.abs(ax*bx+ay*by)>0.002*Math.hypot(ax,ay)*Math.hypot(bx,by))
            throw new IOException("Invalid OCR line quadrilateral");
        // No replacement characters, normalization, or font substitution.
        // Unsupported code points abort before the candidate is saved.
        if (!(fonts.runs(line).stream().mapToDouble(Run::advance).sum()>0)) throw new IOException("OCR line has no font advance");
    }

    static void append(PDDocument doc, PDPage page, List<Line> lines, Fonts fonts, int firstMcid) throws IOException {
        if (lines.isEmpty()) return;
        // Reset context restores source CTM, clipping and text state. All source
        // streams and annotation appearances remain painted by their originals.
        try (var stream = new PDPageContentStream(doc,page,PDPageContentStream.AppendMode.APPEND,true,true)) {
            int mcid=firstMcid;
            for (Line line:lines) {
                double[] q=line.quad(), left=point(page,q[6],q[7]), right=point(page,q[4],q[5]), top=point(page,q[0],q[1]);
                List<Run> runs=fonts.runs(line);double advance=runs.stream().mapToDouble(Run::advance).sum();
                var properties=new COSDictionary();properties.setInt(COSName.MCID,mcid++);
                stream.beginMarkedContent(COSName.getPDFName(line.type()),PDPropertyList.create(properties));
                stream.beginText(); stream.setRenderingMode(RenderingMode.NEITHER);
                stream.setHorizontalScaling(100);stream.setCharacterSpacing(0);stream.setWordSpacing(0);stream.setTextRise(0);
                stream.setTextMatrix(new Matrix((float)((right[0]-left[0])/advance),(float)((right[1]-left[1])/advance),
                    (float)(top[0]-left[0]),(float)(top[1]-left[1]),(float)left[0],(float)left[1]));
                // showText applies GSUB ligatures in PDFBox 3.0.8, which can
                // change the extracted Unicode ("fi" -> U+FB01). Invisible OCR
                // must retain the declared characters. Use the font encoder
                // and PDFBox token serializer, with explicit subset tracking.
                for(Run run:runs) {
                    stream.setFont(run.font(),1);
                    if(run.font().willBeSubset())for(int cp:run.text().codePoints().toArray())run.font().addToSubset(cp);
                    var bytes=new ByteArrayOutputStream();
                    new ContentStreamWriter(bytes).writeTokens(List.of(new COSString(run.encoded()),Operator.getOperator("Tj")));
                    stream.appendRawCommands(bytes.toByteArray());
                }
                stream.endText(); stream.endMarkedContent();
            }
        }
    }
}
