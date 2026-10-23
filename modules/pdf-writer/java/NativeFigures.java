import java.io.IOException;
import java.awt.geom.Point2D;
import java.util.*;
import org.apache.pdfbox.contentstream.PDFGraphicsStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImage;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/** Fresh native image occurrences. PDF.js operator indices are never used here. */
final class NativeFigures extends PDFGraphicsStreamEngine {
    record Image(String origin, int index, double[] bbox, boolean addressable, boolean protectedContent) {}
    final List<Image> images=new ArrayList<>();
    private final Set<COSStream> active=Collections.newSetFromMap(new IdentityHashMap<>());
    private String origin="page";
    private int index, current, operations, invocations;
    private final Deque<Boolean> protectedScopes=new ArrayDeque<>();
    private Point2D point=new Point2D.Float();
    NativeFigures(PDPage page) { super(page); }
    @Override public void processOperator(String op,List<COSBase> args) throws IOException {super.processOperator(Operator.getOperator(op),args);}
    @Override protected void processOperator(Operator op,List<COSBase> args) throws IOException {
        if(++operations>2000000)throw new IOException("Native figure operation limit exceeded");
        current=index++;
        if("BMC".equals(op.getName())||"BDC".equals(op.getName())) {
            if(protectedScopes.size()>=256)throw new IOException("Native figure marked-content depth exceeded");
            String tag=!args.isEmpty()&&args.get(0) instanceof COSName?((COSName)args.get(0)).getName():"";
            COSBase property=args.size()>1?args.get(1):null;
            if(property instanceof COSName&&getResources()!=null){var value=getResources().getProperties((COSName)property);property=value==null?null:value.getCOSObject();}
            protectedScopes.push("Artifact".equals(tag)||"OC".equals(tag)||property instanceof COSDictionary d&&(d.containsKey(COSName.ACTUAL_TEXT)||d.containsKey(COSName.ALT)));
        } else if("EMC".equals(op.getName())) {
            if(protectedScopes.isEmpty())throw new IOException("Unbalanced native figure marked content");protectedScopes.pop();
        }
        if("Do".equals(op.getName())&&args.size()==1&&args.get(0) instanceof COSName&&getResources()!=null&&getResources().getXObject((COSName)args.get(0)) instanceof PDFormXObject form) {
            if(active.size()>=32||++invocations>10000||!active.add(form.getCOSObject()))throw new IOException("Cyclic or excessive native figure Form traversal");
            String parent=origin;int parentIndex=index,parentCurrent=current;
            origin+="/"+current;index=0;
            boolean optional=form.getCOSObject().containsKey(COSName.OC);if(optional)protectedScopes.push(true);
            try {super.processOperator(op,args);} finally {if(optional)protectedScopes.pop();origin=parent;index=parentIndex;current=parentCurrent;active.remove(form.getCOSObject());}
        } else super.processOperator(op,args);
    }
    @Override protected void operatorException(Operator op,List<COSBase> args,IOException ex) throws IOException {throw ex;}
    @Override public void drawImage(PDImage image) throws IOException {
        if(images.size()>=10000)throw new IOException("Native figure image limit exceeded");
        var matrix=getGraphicsState().getCurrentTransformationMatrix();
        double minX=Double.POSITIVE_INFINITY,minY=minX,maxX=Double.NEGATIVE_INFINITY,maxY=maxX;
        for(int x=0;x<=1;x++)for(int y=0;y<=1;y++) {
            var p=matrix.transformPoint(x,y);double[] q=display(getPage(),p.getX(),p.getY());
            minX=Math.min(minX,q[0]);maxX=Math.max(maxX,q[0]);minY=Math.min(minY,q[1]);maxY=Math.max(maxY,q[1]);
        }
        boolean optional=image instanceof PDImageXObject&&((PDImageXObject)image).getCOSObject().containsKey(COSName.OC);
        images.add(new Image(origin,current,new double[]{minX,minY,maxX-minX,maxY-minY},image instanceof PDImageXObject,optional||protectedScopes.contains(true)));
    }
    private static double[] display(PDPage page,double x,double y) throws IOException {
        var b=page.getCropBox();double u=page.getUserUnit();
        if(!Double.isFinite(u)||u<=0)throw new IOException("Invalid native figure UserUnit");
        double[] p=switch(page.getRotation()) {
            case 0 -> new double[]{x-b.getLowerLeftX(),b.getUpperRightY()-y};
            case 90 -> new double[]{y-b.getLowerLeftY(),x-b.getLowerLeftX()};
            case 180 -> new double[]{b.getUpperRightX()-x,y-b.getLowerLeftY()};
            case 270 -> new double[]{b.getUpperRightY()-y,b.getUpperRightX()-x};
            default -> throw new IOException("Unsupported native figure rotation");
        };p[0]*=u;p[1]*=u;return p;
    }
    static boolean matches(double[] a,double[] b) {
        if(a.length!=4||b.length!=4||a[2]<=0||a[3]<=0)return false;
        for(int i=0;i<4;i++)if(!Double.isFinite(a[i])||!Double.isFinite(b[i])||Math.abs(a[i]-b[i])>.5)return false;
        return true;
    }
    @Override public void appendRectangle(Point2D a,Point2D b,Point2D c,Point2D d) {point=a;}
    @Override public void clip(int rule) {}
    @Override public void moveTo(float x,float y) {point=new Point2D.Float(x,y);}
    @Override public void lineTo(float x,float y) {point=new Point2D.Float(x,y);}
    @Override public void curveTo(float a,float b,float c,float d,float x,float y) {point=new Point2D.Float(x,y);}
    @Override public Point2D getCurrentPoint() {return point;}
    @Override public void closePath() {}
    @Override public void endPath() {}
    @Override public void strokePath() {}
    @Override public void fillPath(int rule) {}
    @Override public void fillAndStrokePath(int rule) {}
    @Override public void shadingFill(COSName name) {}
}
