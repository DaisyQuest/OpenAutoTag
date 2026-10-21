import java.io.*;
import java.nio.file.*;
import java.util.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.*;
import org.apache.pdfbox.pdmodel.font.*;
import org.apache.pdfbox.pdmodel.font.encoding.WinAnsiEncoding;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;
import org.apache.pdfbox.pdmodel.interactive.form.*;

/** Locally generated fixture; no private form or operating-system font needed. */
public class FontRepairFixture {
    static COSName n(String s) { return COSName.getPDFName(s); }
    static COSStream stream(PDDocument d, String s) throws IOException {
        COSStream stream = d.getDocument().createCOSStream();
        try (OutputStream out = stream.createOutputStream()) { out.write(s.getBytes(java.nio.charset.StandardCharsets.US_ASCII)); }
        return stream;
    }
    static void create(Path out, String ttf, String mode) throws Exception {
        try (PDDocument d = new PDDocument()) {
            PDPage page = new PDPage(); d.addPage(page); PDResources r = new PDResources(); page.setResources(r);
            PDType1Font zapf = new PDType1Font(Standard14Fonts.FontName.ZAPF_DINGBATS), times = new PDType1Font(Standard14Fonts.FontName.TIMES_ROMAN);
            r.put(n("ZaDb"), zapf); r.put(n("Ti"), times);
            r.put(n("Helv"), new PDType1Font(Standard14Fonts.FontName.HELVETICA));
            PDType0Font embedded = PDType0Font.load(d, new FileInputStream(ttf), false); r.put(n("Embedded"), embedded);
            COSDictionary cid = embedded.getDescendantFont().getCOSObject(), fd = cid.getCOSDictionary(COSName.FONT_DESC);
            fd.setItem(n("CIDSet"), stream(d, "\0"));
            if (mode.equals("nonidentity")) cid.setItem(COSName.CID_TO_GID_MAP, stream(d, "\0\0\0\1"));
            if (mode.equals("badttf")) fd.setItem(COSName.FONT_FILE2, stream(d, "broken"));
            if (mode.equals("custom")) { COSDictionary enc = new COSDictionary(); COSArray diff = new COSArray(); diff.add(COSInteger.get(52)); diff.add(n("a20")); enc.setItem(COSName.DIFFERENCES, diff); zapf.getCOSObject().setItem(COSName.ENCODING, enc); }
            if (mode.equals("widths")) { COSArray w = new COSArray(); w.add(COSInteger.get(123)); zapf.getCOSObject().setItem(COSName.WIDTHS, w); zapf.getCOSObject().setInt(COSName.FIRST_CHAR, 52); zapf.getCOSObject().setInt(COSName.LAST_CHAR, 52); }
            if (mode.equals("pattern")) r.getCOSObject().setItem(COSName.PATTERN, new COSDictionary());
            PDAcroForm form = new PDAcroForm(d); d.getDocumentCatalog().setAcroForm(form);
            PDResources defaults = new PDResources(); defaults.put(n("Helv"), r.getFont(n("Helv"))); defaults.put(n("ZaDb"), zapf);
            if (mode.startsWith("editable")) {
                COSDictionary helvEncoding = new COSDictionary(); helvEncoding.setName(COSName.TYPE, "Encoding"); helvEncoding.setItem(COSName.BASE_ENCODING, COSName.WIN_ANSI_ENCODING);
                // The portable donor's repertoire is explicitly qualified. Undefined slots are not inferred from platform fonts.
                COSArray helvDifferences = new COSArray(); helvDifferences.add(COSInteger.ZERO);
                for(int code=0;code<256;code++) helvDifferences.add(n(code>=32 && code<=126 || code==128 || code==233 ? WinAnsiEncoding.INSTANCE.getName(code) : ".notdef"));
                helvEncoding.setItem(COSName.DIFFERENCES, helvDifferences);
                r.getFont(n("Helv")).getCOSObject().setItem(COSName.ENCODING, helvEncoding);
                PDTrueTypeFont donor = PDTrueTypeFont.load(d, new File(ttf), WinAnsiEncoding.INSTANCE);
                donor.getCOSObject().setName(COSName.BASE_FONT, "Arial");
                defaults.put(n("Arial"), donor); r.put(n("PageFont"), donor);
                if (mode.equals("editable-custom")) donor.getCOSObject().setItem(COSName.ENCODING, new COSDictionary());
                if (mode.equals("editable-badprogram")) donor.getFontDescriptor().getCOSObject().setItem(COSName.FONT_FILE2, stream(d, "invalid"));
                if (mode.equals("editable-duplicate")) {
                    COSDictionary duplicate = new COSDictionary(donor.getCOSObject()); defaults.getCOSObject().getCOSDictionary(COSName.FONT).setItem(n("OtherArial"), duplicate);
                }
                if (mode.equals("editable-widths")) {
                    COSArray widths = new COSArray(); widths.add(COSInteger.ONE);
                    r.getFont(n("Helv")).getCOSObject().setItem(COSName.WIDTHS, widths);
                }
            }
            if (mode.equals("dynamic")) defaults.put(n("Ti"), times);
            form.setDefaultResources(defaults); form.setDefaultAppearance("/Helv 12 Tf 0 g");
            PDCheckBox checkbox = new PDCheckBox(form); checkbox.setPartialName("check"); checkbox.setAlternateFieldName("Check this option");
            checkbox.getCOSObject().setName(COSName.V, "Off"); checkbox.getCOSObject().setName(COSName.DV, "Off");
            PDAnnotationWidget widget = checkbox.getWidgets().get(0); widget.setRectangle(new PDRectangle(40, 650, 16, 16)); widget.setPage(page); widget.setPrinted(true);
            COSStream on = stream(d, "q BT /ZaDb 12 Tf 2 3 Td (4) Tj ET Q");
            on.setName(COSName.TYPE, "XObject"); on.setName(COSName.SUBTYPE, "Form"); on.setItem(COSName.BBOX, new PDRectangle(16, 16).getCOSArray());
            PDResources apResources = new PDResources(); apResources.put(n("ZaDb"), zapf); on.setItem(COSName.RESOURCES, apResources);
            COSStream off = stream(d, "q Q"); off.setName(COSName.TYPE, "XObject"); off.setName(COSName.SUBTYPE, "Form"); off.setItem(COSName.BBOX, new PDRectangle(16, 16).getCOSArray());
            COSDictionary states = new COSDictionary(), ap = new COSDictionary(); states.setItem(n("Yes"), on); states.setItem(n("Off"), off); ap.setItem(COSName.N, states);
            widget.getCOSObject().setItem(COSName.AP, ap); widget.setAppearanceState("Off"); page.getAnnotations().add(widget); form.getFields().add(checkbox);
            PDTextField text = new PDTextField(form); text.setPartialName("details"); text.setAlternateFieldName("Details"); text.setDefaultAppearance(mode.startsWith("editable") ? "/Arial 12 Tf 0 g" : "/Helv 12 Tf 0 g");
            PDAnnotationWidget tw = text.getWidgets().get(0); tw.setRectangle(new PDRectangle(70, 650, 200, 20)); tw.setPage(page); page.getAnnotations().add(tw); form.getFields().add(text); text.setValue("Original value");
            page.setContents(new PDStream(stream(d, "BT /Ti 12 Tf 40 710 Td (" + (mode.equals("visible") ? "Visible" : " ") + ") Tj /" + (mode.startsWith("editable") && !mode.equals("editable-used") ? "PageFont" : "Helv") + " 12 Tf (Font fixture) Tj ET")));
            if (mode.equals("hidden-visible")) {
                on.setItem(COSName.RESOURCES, r); try (OutputStream o = on.createOutputStream()) { o.write("BT /Ti 12 Tf (Visible) Tj ET".getBytes()); }
            }
            if (mode.equals("signed")) { COSDictionary signature = new COSDictionary(); signature.setName(COSName.TYPE, "Sig"); PDSignatureField field = new PDSignatureField(form); field.setPartialName("signature"); field.getCOSObject().setItem(COSName.V, signature); form.getFields().add(field); }
            d.save(out.toFile());
        }
    }
    static void mutate(Path input, Path dir) throws Exception {
        for (String mode : List.of("value", "appearance", "content", "geometry", "program", "unicode", "structure", "info")) {
            try (PDDocument d = Loader.loadPDF(input.toFile())) {
                PDPage p = d.getPage(0); COSDictionary f = p.getResources().getFont(n("ZaDb")).getCOSObject();
                switch (mode) {
                    case "value": d.getDocumentCatalog().getAcroForm(null).getField("details").getCOSObject().setString(COSName.V, "Unexpected"); break;
                    case "appearance": p.getAnnotations().get(0).getCOSObject().getCOSDictionary(COSName.AP).getCOSDictionary(COSName.N).setItem(n("Yes"), stream(d, "q Q")); break;
                    case "content": p.setContents(new PDStream(stream(d, "q Q"))); break;
                    case "geometry": p.setRotation(90); break;
                    case "program": f.getCOSDictionary(COSName.FONT_DESC).setItem(COSName.FONT_FILE3, stream(d, "invalid")); break;
                    case "unicode": f.setItem(COSName.TO_UNICODE, stream(d, "invalid")); break;
                    case "structure": d.getDocumentCatalog().getCOSObject().setItem(COSName.STRUCT_TREE_ROOT, new COSDictionary()); break;
                    case "info": d.getDocumentInformation().setTitle("Unexpected title"); break;
                }
                try (OutputStream out = Files.newOutputStream(dir.resolve(mode + ".pdf"))) { d.saveIncremental(out); }
            }
        }
    }
    public static void main(String[] args) throws Exception {
        if (args[0].equals("create")) {
            Path dir = Path.of(args[1]);
            for (String mode : List.of("valid", "visible", "hidden-visible", "dynamic", "custom", "widths", "pattern", "nonidentity", "badttf", "signed", "editable", "editable-custom", "editable-used", "editable-duplicate", "editable-widths")) create(dir.resolve(mode + ".pdf"), args[2], mode);
        } else if (args[0].equals("mutate")) mutate(Path.of(args[1]), Path.of(args[2]));
        else if (args[0].equals("interact")) {
            try (PDDocument d = Loader.loadPDF(new File(args[1]))) {
                PDAcroForm form = d.getDocumentCatalog().getAcroForm(null);
                ((PDCheckBox)form.getField("check")).check(); ((PDTextField)form.getField("details")).setValue("New saved value");
                if (args.length > 3) {
                    ((PDTextField)form.getField("details")).setDefaultAppearance("/Helv 12 Tf 0 g");
                    ((PDTextField)form.getField("details")).setValue("Jos\u00e9 \u20ac caf\u00e9");
                }
                d.save(args[2]);
            }
            try (PDDocument d = Loader.loadPDF(new File(args[2]))) {
                PDAcroForm f = d.getDocumentCatalog().getAcroForm(null);
                if (!((PDCheckBox)f.getField("check")).isChecked() || !(args.length > 3 ? "Jos\u00e9 \u20ac caf\u00e9" : "New saved value").equals(f.getField("details").getValueAsString())) throw new IOException("Interaction failed");
            }
        }
    }
}
