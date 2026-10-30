// GLES extrans providers. Formulas/table follow Wamsoft/extrans and the
// previously validated JS GPU implementation; no source pixel readback.
#define NCB_MODULE_NAME TJS_W("extrans.dll")
#include "ncbind.hpp"
#include "TransIntf.h"
#include "NativeTexture.h"
#include "render/render.h"
#include "turntrans_table.h"
#include <GLES3/gl3.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
namespace {
using namespace gal::render;
constexpr double Pi = 3.14159265358979323846;
static const char *DistortionDecl = R"GLSL(uniform int kind;
uniform int phase;
uniform int layerType;
uniform ivec2 imageSize;
uniform float curH;
uniform float omega;
uniform float radStart;
uniform vec4 background;
uniform int blockSize;
uniform ivec2 blockOffset;
uniform ivec2 center;
uniform float roundness;
uniform int rippleWidth;
uniform int wavePhase;
uniform int fdrift;
uniform int rippleForm[128];
uniform int cosTable[32];
uniform int sinTable[32];

int reflectCoord(int v, int size) {
  if (size <= 1) return 0;
  while (v < 0 || v >= size) v = v < 0 ? -v : size - 1 - (v - size);
  return v;
}
int signedByte(int v) {
  int b = v & 255;
  return b < 128 ? b : b - 256;
}
ivec2 ripplePoint(ivec2 p) {
  bool right = p.x >= center.x;
  bool top = p.y < center.y;
  int dx = right ? p.x - center.x : center.x - p.x - 1;
  int dy = top ? center.y - p.y - 1 : p.y - center.y;
  float yy = (float(dy) + 0.5) * roundness;
  float xx = float(dx) + 0.5;
  int dir = clamp(int(atan(xx / yy) * (32.0 / 1.5707963267948966)), 0, 31);
  int dist = int(sqrt(xx * xx + yy * yy)) & (rippleWidth - 1);
  int w = (dist + wavePhase) & (rippleWidth - 1);
  int fd = (rippleForm[w] * fdrift) >> 10;
  int xd = (cosTable[dir] * fd) >> 11;
  int yd = (sinTable[dir] * fd) >> 11;
  int sx = signedByte(xd >> 11);
  int sy = signedByte(yd >> 11);
  ivec2 q = ivec2(right ? p.x - sx : p.x + sx, top ? p.y + sy : p.y - sy);
  return ivec2(reflectCoord(q.x, imageSize.x), reflectCoord(q.y, imageSize.y));
}
uint packRGBA(vec4 c) {
  uvec4 b = uvec4(round(clamp(c, 0.0, 1.0) * 255.0));
  return (b.a << 24u) | (b.r << 16u) | (b.g << 8u) | b.b;
}
vec4 unpackRGBA(uint c) {
  return vec4(float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u), float(c >> 24u)) / 255.0;
}
uint mixPixel(uint a, uint b, uint p) {
  uvec4 av = uvec4((a >> 16u) & 255u, (a >> 8u) & 255u, a & 255u, a >> 24u);
  uvec4 bv = uvec4((b >> 16u) & 255u, (b >> 8u) & 255u, b & 255u, b >> 24u);
  uint rgbWeight = p;
  if (layerType == 2 || (layerType >= 13 && layerType <= 28)) {
    p = p > 127u ? p + 1u : p;
    uint adjusted = p;
    float srcAlpha = float((bv.a * adjusted) >> 8u) / 255.0;
    float dstAlpha = float((av.a * (256u - adjusted)) >> 8u) / 255.0;
    float ratio = dstAlpha == 0.0 ? 1e20 : srcAlpha / dstAlpha;
    rgbWeight = uint(clamp(ratio / (1.0 - srcAlpha + ratio) * 255.0, 0.0, 255.0));
  }
  ivec3 rgb = ivec3(av.rgb) + ((ivec3(bv.rgb) - ivec3(av.rgb)) * int(rgbWeight) >> 8);
  int alpha = int(av.a) + ((int(bv.a) - int(av.a)) * int(p) >> 8);
  if (layerType != 2 && layerType != 12 && !(layerType >= 13 && layerType <= 28)) alpha = 0;
  return (uint(alpha) << 24u) | (uint(rgb.r) << 16u) | (uint(rgb.g) << 8u) | uint(rgb.b);
}
uniform ivec2 sourceOrigin; uniform ivec2 secondOrigin;
)GLSL";
static const char *DistortionBody = R"GLSL(ivec2 p = ivec2(v_uv * vec2(textureSize(tex0,0))) + sourceOrigin;
  int blend = min(255, phase);
  ivec2 s = p;
  if (kind == 0) {
    int shift = int(sin(float(p.y) * omega + radStart) * curH);
    s.x -= shift;
    if (s.x < 0 || s.x >= imageSize.x) {
      fragColor = background;
      return;
    }
  } else if (kind == 1) {
    int left = (int(floor(float(p.x - blockOffset.x) / float(blockSize))) * blockSize) + blockOffset.x;
    int top = (int(floor(float(p.y - blockOffset.y) / float(blockSize))) * blockSize) + blockOffset.y;
    s = clamp(ivec2(left + (blockSize >> 1), top + (blockSize >> 1)), ivec2(0), imageSize - 1);
  } else {
    s = ripplePoint(p);
  }
  uint a = packRGBA(texelFetch(tex0, s - sourceOrigin, 0));
  uint b = packRGBA(texelFetch(tex1, s - secondOrigin, 0));
  fragColor = unpackRGBA(mixPixel(a, b, uint(blend)));
)GLSL";
static const char *GeometryDecl = R"GLSL(
uniform int kind;
uniform int phase;
uniform ivec2 imageSize;
uniform vec4 background;
uniform vec3 inverseX;
uniform vec3 inverseY;
uniform ivec2 sourceOrigin; uniform ivec2 secondOrigin;
int tableInt(int x,int y) {
    uvec4 b=uvec4(round(texelFetch(tex2,ivec2(x,y),0)*255.0));
    return int(b.r | (b.g<<8u) | (b.b<<16u) | (b.a<<24u));
}
ivec4 tableVec(int x,int y) {return ivec4(tableInt(x,y),tableInt(x+1,y),tableInt(x+2,y),tableInt(x+3,y));}
)GLSL";
static const char *GeometryBody = R"GLSL(ivec2 p = ivec2(v_uv * vec2(textureSize(tex0,0))) + sourceOrigin;
  if (kind == 0) {
    vec3 v = vec3(vec2(p), 1.0);
    vec2 q = vec2(dot(inverseX,v), dot(inverseY,v));
    if (any(lessThan(q,vec2(0))) || any(greaterThan(q,vec2(imageSize-1)))) discard;
    fragColor = texelFetch(tex0,ivec2(floor(q+0.5))-sourceOrigin,0);
    return;
  }
  ivec2 tile = p / 64;
  int step = clamp(phase-(tile.x-tile.y)*2,0,63);
  if (step == 0) { fragColor = texelFetch(tex0,p-sourceOrigin,0); return; }
  if (step == 63) { fragColor = texelFetch(tex1,p-secondOrigin,0); return; }
  ivec4 a = tableVec((p.y%64)*8,step);
  ivec4 b = tableVec((p.y%64)*8+4,step);
  int local = p.x%64;
  if (local < max(0,a.x) || local >= min(64,a.x+a.y)) { fragColor=background; return; }
  ivec2 q = tile*64 + ((a.zw+b.zw*(local-a.x)) >> 16);
  if (any(lessThan(q,ivec2(0))) || any(greaterThanEqual(q,imageSize))) { fragColor=background; return; }
  vec4 value = step < 32 ? texelFetch(tex0,q-sourceOrigin,0) : texelFetch(tex1,q-secondOrigin,0);
  int gloss = step == 4 ? 16 : step == 5 ? 48 : step == 6 ? 80 : step == 7 ? 128 : step == 8 ? 192 : step == 9 ? 128 : step == 10 ? 80 : step == 11 ? 48 : step == 12 ? 16 : 0;
  ivec4 bytes = ivec4(round(value*255.0));
  fragColor = vec4(bytes+((ivec4(255,255,255,0)-bytes)*gloss >> 8))/255.0;
)GLSL";
static double option(iTVPSimpleOptionProvider *o,const tjs_char *name,double fallback) {
    tTJSVariant value;
    return TJS_SUCCEEDED(o->GetValue(name,&value)) && value.Type()!=tvtVoid ? double(value.AsReal()) : fallback;
}
static void I(Method *m,const char *n,int x){glUniform1i(glGetUniformLocation(m->program,n),x);}
static void F(Method *m,const char *n,float x){glUniform1f(glGetUniformLocation(m->program,n),x);}
static void V2(Method *m,const char *n,int x,int y){glUniform2i(glGetUniformLocation(m->program,n),x,y);}
static void Color(Method *m,const char *n,uint32_t c){glUniform4f(glGetUniformLocation(m->program,n),((c>>16)&255)/255.f,((c>>8)&255)/255.f,(c&255)/255.f,(c>>24)/255.f);}
static Method *program(bool geometry) {
    auto &device=Device::Get(); const char *name=geometry?"ExtransGeometry":"ExtransDistortion";
    auto *m=device.FindMethod(name);
    if(!m)m=device.CompileMethod(name,std::string("{\n")+(geometry?GeometryBody:DistortionBody)+"\n}",false,geometry?GeometryDecl:DistortionDecl,geometry?3:2);
    if(!m)TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
    return m;
}
struct Handler final : iTVPDivisibleTransHandler {
    int refs=1, width,height,type,kind; uint64_t duration,start=0,elapsed=0;bool first=true;
    double maxH,maxOmega,roundness,speed,factor,accel,twist,twistAccel;
    int waveType,maxSize,centerX,centerY,rippleWidth,maxDrift;uint32_t bg,bg2;
    int rippleForm[128]{},cosTable[32]{},sinTable[32]{};
    std::unique_ptr<BitmapSurface> table;
    Handler(int k,iTVPSimpleOptionProvider *o,int w,int h,int lt):width(w),height(h),type(lt),kind(k) {
        tjs_int64 time; if(TJS_FAILED(o->GetAsNumber(TJS_W("time"),&time)))TVPThrowExceptionMessage(TJS_W("Specify time"));
        duration=std::max<tjs_int64>(2,time);
        maxH=option(o,TJS_W("maxh"),50);maxOmega=option(o,TJS_W("maxomega"),.2);waveType=option(o,TJS_W("wavetype"),0);
        bg=option(o,k==0?TJS_W("bgcolor1"):TJS_W("bgcolor"),0);bg2=option(o,TJS_W("bgcolor2"),0);
        maxSize=option(o,TJS_W("maxsize"),30);centerX=option(o,TJS_W("centerx"),w/2);centerY=option(o,TJS_W("centery"),h/2);
        factor=k==5?1:option(o,TJS_W("factor"),1);accel=option(o,TJS_W("accel"),k==5?2:0);
        twist=option(o,TJS_W("twist"),k==6?1:2);twistAccel=option(o,TJS_W("twistaccel"),k==5?2:-2);
        roundness=option(o,TJS_W("roundness"),1);speed=option(o,TJS_W("speed"),6);rippleWidth=option(o,TJS_W("rwidth"),128);maxDrift=option(o,TJS_W("maxdrift"),24);
        if(k==2) {
            if(centerX<0||centerY<0||centerX>=w||centerY>=h||roundness<=0||maxDrift<0||maxDrift>=128||maxDrift>=w||maxDrift>=h||!(rippleWidth==16||rippleWidth==32||rippleWidth==64||rippleWidth==128))TVPThrowExceptionMessage(TJS_W("Invalid ripple options"));
            for(int n=0;n<rippleWidth;++n){double r=-2*Pi*n/rippleWidth;double v=std::clamp((std::sin(r)+std::sin(r*2-2)*.2)/1.19,-1.,1.);rippleForm[n]=std::lround(v*2048);}
            for(int n=0;n<32;++n){double a=Pi*.5-(n+.5)*(Pi/64);cosTable[n]=std::lround(std::cos(a)*2048);sinTable[n]=std::lround(std::sin(a)*2048);}
        }
    }
    tjs_error AddRef() override {++refs;return TJS_S_OK;}
    tjs_error Release() override {if(!--refs)delete this;return TJS_S_OK;}
    tjs_error SetOption(iTVPSimpleOptionProvider *) override{return TJS_S_OK;}
    tjs_error StartProcess(tjs_uint64 tick) override {if(first){start=tick;first=false;}elapsed=std::min(duration,tick-start);return TJS_S_TRUE;}
    tjs_error EndProcess() override{return elapsed>=duration?TJS_S_FALSE:TJS_S_TRUE;}
    tjs_error MakeFinalImage(iTVPScanLineProvider **dest,iTVPScanLineProvider *,iTVPScanLineProvider *s2) override{*dest=s2;return TJS_S_OK;}
    using Points=std::array<std::array<double,2>,3>;
    static double curve(double t,double a){return a<0?1-std::pow(1-t,-a):a>0?std::pow(t,a):t;}
    Points points(int source) {
        double t=double(elapsed)/duration,scx=width/2,scy=height/2,cx,cy,rad,scale;
        double vertical=1;
        if(kind==6){double tm=source==1?t*t:1-(1-t)*(1-t);scale=tm;
            cx=source==1?int(-scx*tm+scx+std::sin(tm*Pi)*scx*1.5):int((scx-(width-1))*tm+(width-1)-std::sin(tm*Pi)*scx*1.5);
            cy=source==1?int(-scy*tm+scy):int((scy-(height-1))*tm+height-1);rad=(source==1?tm:tm-1)*twist*2*Pi;vertical=tm;
        }else{double zm=curve(t,accel);cx=int((scx-centerX)*zm+centerX);cy=int((scy-centerY)*zm+centerY);rad=elapsed==duration?0:2*Pi*twist*curve(t,twistAccel);scale=((kind==5?0:1)-factor)*zm+factor;}
        double sn=std::sin(rad)*scale,cs=std::cos(rad)*scale;
        double ox=kind==6?cx:scx,oy=kind==6?cy:scy;if(kind==6){cx=scx;cy=scy;}
        Points p{};int xs[3]={0,width-1,0},ys[3]={0,0,height-1};
        for(int n=0;n<3;++n){p[n][0]=int((xs[n]-cx)*cs+(ys[n]-cy)*sn+ox);p[n][1]=int(((xs[n]-cx)*-sn+(ys[n]-cy)*cs)*vertical+oy);}return p;
    }
    tjs_error Process(tTVPDivisibleData *d) override;
};

tjs_error Handler::Process(tTVPDivisibleData *d) {
    if(elapsed==0||elapsed>=duration){bool end=elapsed>=duration;d->Dest=end?d->Src2:d->Src1;d->DestLeft=end?d->Src2Left:d->Src1Left;d->DestTop=end?d->Src2Top:d->Src1Top;return TJS_S_OK;}
    // Keep input storage alive before a destination CoW can replace it.
    auto &firstTex=*static_cast<tTVPGLESTexture *>(d->Src1->GetTexture());
    auto &secondTex=*static_cast<tTVPGLESTexture *>(d->Src2->GetTexture());
    if(firstTex.GetWidth()>unsigned(Device::Get().MaxTextureSize()-2)||firstTex.GetHeight()>unsigned(Device::Get().MaxTextureSize()-2)||secondTex.GetWidth()>unsigned(Device::Get().MaxTextureSize()-2)||secondTex.GetHeight()>unsigned(Device::Get().MaxTextureSize()-2))
        TVPThrowExceptionMessage(TJS_W("extrans requires sources that fit one GLES texture"));
    BitmapSurface a(firstTex.GetSurface()),b(secondTex.GetSurface());
    auto &output=*static_cast<tTVPGLESTexture *>(d->Dest->GetTextureForRender());
    auto &target=output.GetSurface();
    const Rect dest(d->DestLeft,d->DestTop,d->DestLeft+d->Width,d->DestTop+d->Height);
    const double t=double(elapsed)/duration,half=duration/2.;
    auto draw=[&](const BitmapSurface &one,const BitmapSurface &two,bool swapped,const std::function<void(Method *)> &uniforms){
        Method *m=program(kind>=3);
        std::vector<const BitmapSurface *> sources{&one,&two};
        if(kind>=3){if(!table){if(kind==3)table=BitmapSurface::FromRGBA(TurnTransParams,512,64,512*4);else table=BitmapSurface::Create(1,1);}sources.push_back(table.get());}
        std::vector<BitmapSurface::MeshVertex> vertices(6);const int order[6]={0,1,2,2,1,3};
        const int sx=swapped?d->Src2Left:d->Src1Left,sy=swapped?d->Src2Top:d->Src1Top;
        const int sx2=swapped?d->Src1Left:d->Src2Left,sy2=swapped?d->Src1Top:d->Src2Top;
        for(int n=0;n<6;++n){int c=order[n],x=(c==1||c==3)?d->Width:0,y=c>=2?d->Height:0;auto &v=vertices[n];v.x=d->DestLeft+x;v.y=d->DestTop+y;v.texture={{double(sx+x),double(sy+y)},{double(sx2+x),double(sy2+y)}};if(kind>=3)v.texture.push_back({0,0});}
        target.DrawMesh(sources,vertices,dest,m,255,Filter::Nearest,[&]{
            V2(m,"sourceOrigin",d->Left-sx,d->Top-sy);V2(m,"secondOrigin",d->Left-sx2,d->Top-sy2);
            V2(m,"imageSize",width,height);uniforms(m);
        });
    };
    if(kind<3){draw(a,b,false,[&](Method *m){
        I(m,"kind",kind);I(m,"phase",int(elapsed*255/duration));I(m,"layerType",type);
        if(kind==0){double folded=std::min(double(elapsed),double(duration-elapsed));double tt=std::sin(Pi*.5*folded/half);
            double omega=maxOmega*(waveType==1?1-t:waveType==2?t:tt);F(m,"curH",tt*maxH);F(m,"omega",omega);F(m,"radStart",-omega*(height/2));
            const int opa=int(elapsed*255/duration);uint32_t c=0;
            for(int shift=0;shift<32;shift+=8){int av=(bg>>shift)&255,bv=(bg2>>shift)&255;c|=uint32_t(av+((bv-av)*opa>>8))<<shift;}Color(m,"background",c);
        }else if(kind==1){double folded=std::min(double(elapsed),double(duration-elapsed));int block=int((maxSize-2)*folded/half+2);if(block<=0)TVPThrowExceptionMessage(TJS_W("Invalid mosaic block size"));
            int ox=(width-block)/2-int((width/2)/block)*block,oy=(height-block)/2-int((height/2)/block)*block;if(ox>0)ox-=block;if(oy>0)oy-=block;I(m,"blockSize",block);V2(m,"blockOffset",ox,oy);
        }else{int phase=int(speed/(2*Pi)/1000*elapsed*rippleWidth)%rippleWidth;phase=std::max(0,phase);int drift=std::clamp(int(std::sin(Pi*t)*maxDrift*4),0,std::max(0,maxDrift*4-1));
            V2(m,"center",centerX,centerY);F(m,"roundness",roundness);I(m,"rippleWidth",rippleWidth);I(m,"wavePhase",rippleWidth-phase-1);I(m,"fdrift",(drift<<10)/4);
            glUniform1iv(glGetUniformLocation(m->program,"rippleForm[0]"),128,rippleForm);glUniform1iv(glGetUniformLocation(m->program,"cosTable[0]"),32,cosTable);glUniform1iv(glGetUniformLocation(m->program,"sinTable[0]"),32,sinTable);
        }
    });}else if(kind==3){draw(a,b,false,[&](Method *m){I(m,"kind",1);I(m,"phase",int(elapsed*(64+((width-1)/64+1+(height-1)/64+1)*2)/duration)-((height-1)/64+1)*2);Color(m,"background",bg);});}
    else{
        if(kind==6)target.Fill(dest,bg);else target.Copy(kind==4?a:b,Rect(kind==4?d->Src1Left:d->Src2Left,kind==4?d->Src1Top:d->Src2Top,(kind==4?d->Src1Left:d->Src2Left)+d->Width,(kind==4?d->Src1Top:d->Src2Top)+d->Height),d->DestLeft,d->DestTop);
        auto affine=[&](int source){auto p=points(source);double ax=(p[1][0]-p[0][0])/(width-1),ay=(p[1][1]-p[0][1])/(width-1),bx=(p[2][0]-p[0][0])/(height-1),by=(p[2][1]-p[0][1])/(height-1);double det=ax*by-ay*bx;if(det==0)return;
            double a0=by/det,a1=-bx/det,b0=-ay/det,b1=ax/det;
            draw(source==1?a:b,source==1?b:a,source==2,[&](Method *m){I(m,"kind",0);glUniform3f(glGetUniformLocation(m->program,"inverseX"),a0,a1,-a0*p[0][0]-a1*p[0][1]);glUniform3f(glGetUniformLocation(m->program,"inverseY"),b0,b1,-b0*p[0][0]-b1*p[0][1]);});
        };
        if(kind==6){if(t>=.5){affine(1);affine(2);}else{affine(2);affine(1);}}else affine(kind==4?2:1);
    }
    output.DidRender();return TJS_S_OK;
}
struct Provider final : iTVPTransHandlerProvider {
    const tjs_char *name;int kind,refs=1;
    Provider(const tjs_char *n,int k):name(n),kind(k){}
    tjs_error AddRef() override{++refs;return TJS_S_OK;}
    tjs_error Release() override{if(!--refs)delete this;return TJS_S_OK;}
    tjs_error GetName(const tjs_char **out) override{*out=name;return TJS_S_OK;}
    tjs_error StartTransition(iTVPSimpleOptionProvider *o,iTVPSimpleImageProvider *,tTVPLayerType lt,tjs_uint w,tjs_uint h,tjs_uint w2,tjs_uint h2,tTVPTransType *type,tTVPTransUpdateType *update,iTVPBaseTransHandler **out) override{
        if(w!=w2||h!=h2)TVPThrowExceptionMessage(TJS_W("extrans source image sizes differ"));
        *type=ttExchange;*update=tutDivisible;*out=new Handler(kind,o,w,h,lt);return TJS_S_OK;
    }
};
static void RegisterExtrans(){
    static bool registered=false;if(registered)return;
    const tjs_char *names[]={TJS_W("wave"),TJS_W("mosaic"),TJS_W("ripple"),TJS_W("turn"),TJS_W("rotatezoom"),TJS_W("rotatevanish"),TJS_W("rotateswap")};
    for(int k=0;k<7;++k){auto *p=new Provider(names[k],k);TVPAddTransHandlerProvider(p);p->Release();}registered=true;
}
} // namespace
NCB_POST_REGIST_CALLBACK(RegisterExtrans);
