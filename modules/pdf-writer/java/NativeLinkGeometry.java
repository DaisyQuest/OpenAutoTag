import java.util.*;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;

/** Default-user-space activation regions. Invalid quads require review;
 * their Rect still blocks competing annotations from appearing unambiguous. */
final class NativeLinkGeometry {
    static final int MAX_QUADS=1024;
    final PDRectangle rect;
    final List<double[]> quads=new ArrayList<>();
    boolean rectangleValid;
    String reviewReason;

    NativeLinkGeometry(COSDictionary annotation,PDRectangle rectangle) {
        rect=rectangle;
        rectangleValid=rect!=null&&Float.isFinite(rect.getLowerLeftX())&&Float.isFinite(rect.getLowerLeftY())
            &&Float.isFinite(rect.getUpperRightX())&&Float.isFinite(rect.getUpperRightY())&&rect.getWidth()>0&&rect.getHeight()>0;
        if(!rectangleValid){reviewReason="Missing or invalid link rectangle";return;}
        if(annotation.containsKey(COSName.getPDFName("Path"))){reviewReason="Link Path activation geometry requires review";return;}
        if(!annotation.containsKey(COSName.getPDFName("QuadPoints")))return;
        COSBase value=annotation.getDictionaryObject(COSName.getPDFName("QuadPoints"));
        if(!(value instanceof COSArray array)||array.size()==0||array.size()%8!=0||array.size()>8*MAX_QUADS){reviewReason="Invalid or excessive link QuadPoints";return;}
        for(int start=0;start<array.size();start+=8) {
            double[] q=new double[8];
            for(int i=0;i<8;i++) {
                COSBase v=array.getObject(start+i);
                if(!(v instanceof COSNumber number)||!Float.isFinite(number.floatValue())){reviewReason="Non-numeric or non-finite link QuadPoints";return;}
                q[i]=number.floatValue();
            }
            for(int i=0;i<8;i+=2)if(q[i]<rect.getLowerLeftX()||q[i]>rect.getUpperRightX()||q[i+1]<rect.getLowerLeftY()||q[i+1]>rect.getUpperRightY()) {
                reviewReason="Link QuadPoints extend outside Rect; fallback activation requires review";return;
            }
            double area=0;boolean nondegenerate=true;
            for(int i=0;i<4;i++) {int a=2*i,b=2*((i+1)%4);area+=q[a]*q[b+1]-q[a+1]*q[b];if(Math.abs(turn(q,i,(i+1)%4,(i+2)%4))<=1e-8)nondegenerate=false;}
            if(!nondegenerate||area<=1e-8||crosses(q,0,1,2,3)||crosses(q,1,2,3,0)) {
                reviewReason="Link QuadPoints must be nondegenerate simple counterclockwise regions";return;
            }
            quads.add(q);
        }
    }

    private static double turn(double[] q,int a,int b,int c){return (q[2*b]-q[2*a])*(q[2*c+1]-q[2*a+1])-(q[2*b+1]-q[2*a+1])*(q[2*c]-q[2*a]);}
    private static boolean crosses(double[] q,int a,int b,int c,int d){return turn(q,a,b,c)*turn(q,a,b,d)<=0&&turn(q,c,d,a)*turn(q,c,d,b)<=0;}

    int complexity(){return reviewReason==null?Math.max(1,quads.size()):1;}
    boolean contains(double x,double y) {
        if(!rectangleValid||!Double.isFinite(x)||!Double.isFinite(y))return false;
        if(x<rect.getLowerLeftX()-0.25||x>rect.getUpperRightX()+0.25||y<rect.getLowerLeftY()-0.25||y>rect.getUpperRightY()+0.25)return false;
        if(reviewReason!=null||quads.isEmpty())return true;
        for(double[] q:quads) {
            boolean inside=false,nearEdge=false;
            for(int i=0;i<4;i++) {
                int a=2*i,b=2*((i+1)%4);double dx=q[b]-q[a],dy=q[b+1]-q[a+1];
                double t=Math.max(0,Math.min(1,((x-q[a])*dx+(y-q[a+1])*dy)/(dx*dx+dy*dy)));
                if(Math.hypot(x-q[a]-t*dx,y-q[a+1]-t*dy)<=0.25)nearEdge=true;
                if((q[a+1]>y)!=(q[b+1]>y)&&x<q[a]+(y-q[a+1])*dx/dy)inside=!inside;
            }
            if(inside||nearEdge)return true;
        }
        return false;
    }
}
