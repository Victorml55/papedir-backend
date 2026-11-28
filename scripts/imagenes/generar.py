# Genera ilustraciones 800x800 (emoji grande sobre degradado) para productos y tiendas.
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import json
EMOJI = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 109)
# clave: (emoji, color1, color2)
C = {
 'taco':('🌮','#FFE3B3','#FFB86B'), 'gringa':('🫓','#FFE9C2','#F6B26B'), 'quesadilla':('🫓','#FFF1C7','#F7C66B'), 'burrito':('🌯','#FFE7BF','#E9A35B'),
 'volcan':('🌮','#FFD9C2','#F08A5D'), 'torta':('🥪','#FFEBC6','#E8B067'), 'hamburguesa':('🍔','#FFE0B8','#E9964F'), 'hotdog':('🌭','#FFE3BA','#EE9F55'),
 'pizza':('🍕','#FFE1C4','#F08C5A'), 'pollo':('🍗','#FFE4C0','#E79A52'), 'sushi':('🍣','#FFE3E3','#F49A9A'), 'ramen':('🍜','#FFF0D1','#F2B66D'),
 'ensalada':('🥗','#E4F7DA','#9BD67E'), 'sopa':('🍲','#FFE7CF','#EDA067'), 'papas':('🍟','#FFF3C4','#F2C34E'), 'pan':('🥖','#FFF0D6','#E3B176'),
 'cafe':('☕','#EFE2D6','#B98A64'), 'refresco':('🥤','#FFDCDC','#F08080'), 'agua':('🧃','#E3F3FF','#8CC8F2'), 'horchata':('🥛','#FFF8EC','#E8D2B0'),
 'jugo':('🧃','#FFF0CF','#F5B94E'), 'cerveza':('🍺','#FFF2C2','#F2C340'), 'te':('🍵','#E6F4DE','#9CCB86'),
 'flan':('🍮','#FFF0CC','#F0B658'), 'pastel':('🍰','#FFE6EE','#F4A3BD'), 'helado':('🍨','#FFE9F2','#F2A8C8'), 'galleta':('🍪','#F8E8D2','#D9A66B'),
 'dona':('🍩','#FFE4EE','#EE9DB9'), 'chocolate':('🍫','#F1E1D6','#A8765A'), 'dulce':('🍬','#FFE6F3','#F29CC9'),
 'arroz':('🍚','#F7F7F2','#D9D4C2'), 'frijol':('🫘','#F2E2DA','#B07A64'), 'aceite':('🫒','#F2F5D6','#C2C96B'), 'huevo':('🥚','#FFF7E6','#F0D9A8'),
 'leche':('🥛','#EEF6FF','#A9CCEF'), 'queso':('🧀','#FFF4C8','#F2CC52'), 'fruta':('🍎','#FFE1E1','#EF7B7B'), 'verdura':('🥕','#FFE9D6','#F29C5C'),
 'carne':('🥩','#FFE0DE','#E5837A'), 'tortilla':('🫓','#FFF2D6','#E9C27F'), 'azucar':('🧂','#F6F6F6','#CFCFCF'), 'cereal':('🥣','#FFF1D8','#EDBE76'),
 'shampoo':('🧴','#E6F1FF','#94BEEF'), 'pasta_dental':('🪥','#E3F7F6','#7FD0CB'), 'jabon':('🧼','#EAF2FF','#9DB9F0'), 'papel':('🧻','#F5F5F5','#D2D2D2'),
 'alcohol':('🧪','#E9F4FF','#8FBDEA'), 'curitas':('🩹','#FFEFE3','#F2B48A'), 'suero':('🧃','#E6F7FF','#86C9EC'), 'medicina':('💊','#FFE8EC','#F09AA8'),
 'vitamina':('💊','#FFF3D6','#F2C46B'), 'cubrebocas':('😷','#EAF4FF','#9CC3EE'), 'termometro':('🌡️','#FFE9E6','#EE958A'),
 'martillo':('🔨','#ECEFF3','#9AA6B4'), 'desarmador':('🪛','#FFF0D9','#E9AF62'), 'cinta_metrica':('📏','#FFF6CF','#EBC94A'), 'foco':('💡','#FFF8D1','#F2D24A'),
 'cinta_aislar':('⚡','#E8EAF0','#8C93A6'), 'extension':('🔌','#E9EEF5','#93A4BB'), 'pintura':('🖌️','#E8F3FF','#8DB5EA'), 'tornillo':('🔩','#EEF0F2','#A4ACB5'),
 'llave':('🔧','#EDEFF2','#9AA4B0'), 'pegamento':('🧴','#FFF4D9','#E8C47A'), 'bateria':('🔋','#E6F6E6','#86C986'),
 # genéricos por categoría de tienda
 'gen_comida':('🍽️','#FFE8CF','#F2A766'), 'gen_abarrotes':('🛒','#E6F2E6','#8FC48F'), 'gen_farmacia':('💊','#E6F2FF','#8DB9EA'),
 'gen_materiales':('🧰','#ECEEF2','#98A3B3'), 'gen_otros':('🛍️','#F0E6FF','#B49AEB'),
 'tienda_comida':('🍽️','#FFE2C6','#EE9450'), 'tienda_abarrotes':('🏪','#DDF0DD','#6FB46F'), 'tienda_farmacia':('⚕️','#DDEBFF','#6FA3E6'),
 'tienda_materiales':('🛠️','#E4E7EC','#7D899B'), 'tienda_otros':('🛍️','#EBDDFF','#9E7BE3'),
}
def emoji_img(e, px):
    im = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((80, 80), e, font=EMOJI, embedded_color=True, anchor='mm')
    im = im.crop(im.getbbox())
    s = px / max(im.size)
    return im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
def hexrgb(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5))
def generar(clave, e, c1, c2):
    W = 800
    a, b = hexrgb(c1), hexrgb(c2)
    fondo = Image.new('RGB', (W, W))
    px = fondo.load()
    for y in range(W):
        for x in range(W):
            t = (x + y) / (2 * W)
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    # círculo claro detrás del ícono
    capa = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(capa).ellipse((150, 150, 650, 650), fill=(255, 255, 255, 110))
    fondo.paste(capa, (0, 0), capa)
    ic = emoji_img(e, 380)
    sombra = Image.new('RGBA', ic.size, (0, 0, 0, 0)); sombra.putalpha(ic.getchannel('A').point(lambda v: v * 0.25))
    sombra = sombra.filter(ImageFilter.GaussianBlur(12))
    x, y = (W - ic.width) // 2, (W - ic.height) // 2
    fondo.paste(sombra, (x + 8, y + 18), sombra)
    fondo.paste(ic, (x, y), ic)
    fondo.save(f'imagenes/{clave}.jpg', quality=88, optimize=True)
for k, (e, c1, c2) in C.items(): generar(k, e, c1, c2)
print(len(C))
