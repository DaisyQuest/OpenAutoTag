import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import javax.imageio.ImageIO;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.apache.pdfbox.util.Matrix;

/** Independent raster oracles; contains no production geometry helper. */
public class OcrGeometryProbe {
    static final float W=360.375f,H=240.625f,X=23.375f,Y=49.625f,IW=300,IH=42;
    static int[] bounds(BufferedImage image) {
        int l=image.getWidth(),t=image.getHeight(),r=0,b=0;
        for(int y=0;y<image.getHeight();y++)for(int x=0;x<image.getWidth();x++) {
            int rgb=image.getRGB(x,y);
            if(((rgb>>16)&255)+((rgb>>8)&255)+(rgb&255)<300) {l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x+1);b=Math.max(b,y+1);}
        }
        if(r<=l)throw new IllegalStateException("No ink in oracle image");
        return new int[]{l,t,r,b};
    }
    static BufferedImage image(int w,int h) {
        BufferedImage image=new BufferedImage(w,h,BufferedImage.TYPE_INT_RGB);
        Graphics2D g=image.createGraphics();g.setColor(Color.WHITE);g.fillRect(0,0,w,h);g.dispose();return image;
    }
    static void create(Path dir) throws Exception {
        Files.createDirectories(dir);
        BufferedImage image=image(720,100);Graphics2D g=image.createGraphics();g.setColor(Color.BLACK);
        g.setFont(new Font("SansSerif",Font.PLAIN,64));g.drawString("IMAGE TEXT 123",20,75);g.dispose();
        int[] ink=bounds(image);
        String bbox="["+(X+ink[0]*IW/720)+","+(Y+ink[1]*IH/100)+","+((ink[2]-ink[0])*IW/720)+","+((ink[3]-ink[1])*IH/100)+"]";
        java.util.List<String> pages=new ArrayList<>();
        try(PDDocument doc=new PDDocument()) {
            var bitmap=LosslessFactory.createFromImage(doc,image);int number=0;
            for(float unit:new float[]{1,2.5f})for(int origin:new int[]{0,1})for(int rotation:new int[]{0,90,180,270}) {
                float cx=origin==0?0:-27.25f,cy=origin==0?0:38.125f;
                boolean side=rotation==90||rotation==270;float rw=(side?H:W)/unit,rh=(side?W:H)/unit;
                PDPage page=new PDPage(new PDRectangle(cx-20,cy-20,rw+40,rh+40));
                page.setCropBox(new PDRectangle(cx,cy,rw,rh));page.setRotation(rotation);page.setUserUnit(unit);doc.addPage(page);
                Matrix transform=switch(rotation) {
                    case 0 -> new Matrix(1/unit,0,0,1/unit,cx,cy);
                    case 90 -> new Matrix(0,1/unit,-1/unit,0,cx+H/unit,cy);
                    case 180 -> new Matrix(-1/unit,0,0,-1/unit,cx+W/unit,cy+H/unit);
                    default -> new Matrix(0,-1/unit,1/unit,0,cx,cy+W/unit);
                };
                try(PDPageContentStream out=new PDPageContentStream(doc,page)) {
                    out.transform(transform);out.drawImage(bitmap,X,H-Y-IH,IW,IH);
                }
                pages.add("{\"pageNumber\":"+(++number)+",\"rotation\":"+rotation+",\"userUnit\":"+unit+",\"bbox\":"+bbox+"}");
            }
            doc.save(dir.resolve("source.pdf").toFile());
            doc.getPage(0).setUserUnit(50);doc.save(dir.resolve("oversized.pdf").toFile());
        }
        Files.writeString(dir.resolve("oracle.json"),"["+String.join(",",pages)+"]");
        java.util.List<String> deskew=new ArrayList<>();
        for(int direction:new int[]{-1,1}) {
            double angle=direction*.12;String name=direction<0?"negative":"positive";
            BufferedImage canvas=image(1201,901);Graphics2D combined=canvas.createGraphics();
            for(int i=0;i<3;i++) {
                BufferedImage line=image(1201,901);Graphics2D text=line.createGraphics();
                text.rotate(angle,600,450);text.setColor(Color.BLACK);text.setFont(new Font("SansSerif",Font.PLAIN,42));
                String words="ACCESSIBLE TEXT "+(123+i);text.drawString(words,210,220+i*90);text.dispose();
                int[] b=bounds(line);
                deskew.add("{\"image\":\"deskew-"+name+".png\",\"text\":\""+words+"\",\"bbox\":["+b[0]+","+b[1]+","+(b[2]-b[0])+","+(b[3]-b[1])+"]}");
                // Combine black pixels only; keep previous lines.
                for(int y=b[1];y<b[3];y++)for(int x=b[0];x<b[2];x++)if((line.getRGB(x,y)&0xffffff)!=0xffffff)canvas.setRGB(x,y,line.getRGB(x,y));
            }
            combined.dispose();ImageIO.write(canvas,"PNG",dir.resolve("deskew-"+name+".png").toFile());
        }
        Files.writeString(dir.resolve("deskew-oracle.json"),"["+String.join(",",deskew)+"]");
    }
    public static void main(String[] args) throws Exception {
        Path dir=Path.of(args[1]);
        if(args[0].equals("create")){create(dir);return;}
        java.util.List<String> output=new ArrayList<>();
        try(var files=Files.list(dir)) {
            for(Path p:files.filter(f->f.toString().endsWith(".png")).sorted().toList()) {
                int[] b=bounds(ImageIO.read(p.toFile()));output.add("{\"file\":\""+p.getFileName()+"\",\"box\":{\"x0\":"+b[0]+",\"y0\":"+b[1]+",\"x1\":"+b[2]+",\"y1\":"+b[3]+"}}");
            }
        }
        System.out.println("["+String.join(",",output)+"]");
    }
}
