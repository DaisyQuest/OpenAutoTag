import java.io.IOException;
import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.documentinterchange.logicalstructure.PDStructureElement;
import org.apache.pdfbox.pdmodel.interactive.annotation.*;

/** Source glyph evidence for native links. Never changes an action or appearance. */
final class NativeLinkOwnership {
    static final class Link {
        final PDPage page; final PDAnnotationLink annotation; final int pageNumber, index;
        final String sourceRef; final COSBase originalContents;
        final Set<String> expected = new LinkedHashSet<>();
        final Set<String> assigned = new LinkedHashSet<>();
        final List<Map<String,Object>> ranges = new ArrayList<>();
        String reason = "No unambiguous tagged anchor text", ownerTagId, anchorText = "";
        boolean uncertain, eligible, geometrySupported, suppressedRedundantActualText;
        PDStructureElement element;
        int parentKey = -1;
        Link(PDPage page, PDAnnotationLink annotation, int pageNumber, int index) {
            this.page=page; this.annotation=annotation; this.pageNumber=pageNumber; this.index=index;
            COSObjectKey key=annotation.getCOSObject().getKey(); sourceRef=key==null?"direct":key.getNumber()+" "+key.getGeneration()+" R";
            originalContents=annotation.getCOSObject().getItem(COSName.CONTENTS);
        }
        void review(String why) { uncertain=true;eligible=false;reason=why; }
        Map<String,Object> report() {
            Map<String,Object> out=new LinkedHashMap<>(); out.put("pageNumber",pageNumber);out.put("annotationIndex",index);out.put("sourceAnnotationRef",sourceRef);
            out.put("status",element==null?"review_required":"bound");out.put("reason",element==null?reason:"Source anchor glyphs, Link, OBJR and annotation ParentTree entry are connected");
            if(element!=null) {out.put("ownerTagId",ownerTagId);out.put("anchorText",anchorText);out.put("linkStructureId",element.getElementIdentifier());out.put("parentTreeKey",parentKey);out.put("ranges",ranges);}
            if(element!=null&&suppressedRedundantActualText)out.put("suppressedRedundantActualText",true);
            return out;
        }
    }
    record OperatorEvidence(NativeContentStreamParser.OperatorRecord record, Link[] glyphLinks) {}
    final List<Link> links=new ArrayList<>();
    final Map<String,OperatorEvidence> operators=new HashMap<>();
    static String address(String origin,int index){return origin+":"+index;}
    static String glyphKey(String origin,int index,int glyph){return address(origin,index)+":"+glyph;}

    NativeLinkOwnership(PDDocument document, int pageNumber) throws IOException {
        PDPage page=document.getPage(pageNumber-1);List<PDAnnotation> annotations=page.getAnnotations();
        for(int i=0;i<annotations.size();i++) if(annotations.get(i) instanceof PDAnnotationLink annotation) {
            if(links.size()>=4096)throw new IOException("Native link annotation limit exceeded");
            Link link=new Link(page,annotation,pageNumber,i);links.add(link);
            PDRectangle r=annotation.getRectangle();
            if(r==null||!Float.isFinite(r.getLowerLeftX())||!Float.isFinite(r.getLowerLeftY())||!Float.isFinite(r.getUpperRightX())||!Float.isFinite(r.getUpperRightY())||r.getWidth()<=0||r.getHeight()<=0)
                link.review("Missing or invalid link rectangle");
            else if(annotation.isHidden()||annotation.isInvisible()||annotation.isNoView())link.review("Hidden link requires visibility review");
            else if(annotation.getCOSObject().containsKey(COSName.getPDFName("QuadPoints")))link.review("Quad-point link geometry requires dedicated qualification");
            else if(!Set.of(0,90,180,270).contains(page.getRotation()))link.review("Unsupported page rotation");
            // Unsupported QuadPoints still create an ambiguous hit for an
            // overlapping rectangle; they must not make a neighbor seem unique.
            link.geometrySupported=r!=null&&Float.isFinite(r.getWidth())&&Float.isFinite(r.getHeight())&&r.getWidth()>0&&r.getHeight()>0
                &&!annotation.isHidden()&&!annotation.isInvisible()&&!annotation.isNoView();
        }
        if(links.isEmpty())return;
        Set<COSDictionary> wanted=Collections.newSetFromMap(new IdentityHashMap<>());
        for(Link link:links)if(!wanted.add(link.annotation.getCOSObject()))throw new IOException("Link annotation is repeated in page arrays");
        int seen=0,scanned=0;
        for(PDPage other:document.getPages())for(PDAnnotation annotation:other.getAnnotations()) {
            if(++scanned>100000)throw new IOException("Native annotation traversal limit exceeded");
            if(wanted.contains(annotation.getCOSObject()))seen++;
        }
        if(seen!=wanted.size())throw new IOException("Link annotation is repeated in page arrays");
        var parser=new NativeContentStreamParser();long comparisons=0;int glyphs=0;
        for(var record:parser.parseOnePage(document,pageNumber-1)) {
            if(record.mapping==null||record.glyphPositions.size()!=record.mapping.glyphs.size()) {
                if(record.text!=null&&!record.text.isBlank())for(Link link:links)link.review("Page contains source text without complete glyph geometry");
                continue;
            }
            if((glyphs+=record.mapping.glyphs.size())>1000000)throw new IOException("Native link glyph limit exceeded");
            Link[] selected=new Link[record.mapping.glyphs.size()];
            for(int g=0;g<selected.length;g++) {
                float[] point=record.glyphPositions.get(g);List<Link> hits=new ArrayList<>();
                for(Link link:links) {
                    if(++comparisons>10000000)throw new IOException("Native link geometry comparison limit exceeded");
                    if(link.geometrySupported&&contains(link,point[0],point[1]))hits.add(link);
                }
                boolean meaningful=!record.mapping.glyphs.get(g).unicode.isBlank();
                if(hits.size()>1) {
                    if(meaningful)for(Link link:hits)link.review("Overlapping annotations make anchor ownership ambiguous");
                } else if(hits.size()==1) {
                    Link link=hits.get(0);selected[g]=link;
                    if(meaningful)link.expected.add(glyphKey(record.streamOrigin,record.opIndexInStream,g));
                }
            }
            operators.put(address(record.streamOrigin,record.opIndexInStream),new OperatorEvidence(record,selected));
        }
        // Earlier glyphs must not retain a link later found ambiguous.
        for(OperatorEvidence op:operators.values())for(int g=0;g<op.glyphLinks.length;g++)if(op.glyphLinks[g]!=null&&op.glyphLinks[g].uncertain)op.glyphLinks[g]=null;
    }
    private static boolean contains(Link link,double x,double y) {
        PDRectangle crop=link.page.getCropBox(),r=link.annotation.getRectangle();double px,py;
        // TextPosition supplies crop-relative, rotated display coordinates in
        // default user units. Convert both axes back, before comparing /Rect.
        switch(link.page.getRotation()) {
            case 90:px=crop.getLowerLeftX()+y;py=crop.getLowerLeftY()+x;break;
            case 180:px=crop.getUpperRightX()-x;py=crop.getLowerLeftY()+y;break;
            case 270:px=crop.getUpperRightX()-y;py=crop.getUpperRightY()-x;break;
            default:px=crop.getLowerLeftX()+x;py=crop.getUpperRightY()-y;
        }
        return px>=r.getLowerLeftX()-0.25&&px<=r.getUpperRightX()+0.25&&py>=r.getLowerLeftY()-0.25&&py<=r.getUpperRightY()+0.25;
    }
    void restoreAuthoredContents() {
        for(Link link:links) {
            COSBase resolved=link.originalContents instanceof COSObject o?o.getObject():link.originalContents;
            if(resolved instanceof COSString value&&!value.getString().isBlank())link.annotation.getCOSObject().setItem(COSName.CONTENTS,link.originalContents);
        }
    }
}
