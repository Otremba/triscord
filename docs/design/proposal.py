"""Draw the review proposal without launching/capturing an application or browser.

Produces an editable SVG plus a PNG from the same scene using Pillow.
All names/content are illustrative, not a live account or working media session.
"""
from pathlib import Path
from html import escape
import argparse
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--revision', choices=['01','02'], default='01')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
W, H = 1600, 1040
image = Image.new('RGB', (W, H), '#101215')
draw = ImageDraw.Draw(image)
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
       '<title>Proposta de direção visual do Triscord</title>',
       '<desc>Tela conceitual com navegação, canais, chamada, mensagens e participantes. Dados ilustrativos; não representa mídia em execução.</desc>']
TEXT, MUTED, SUBTLE = '#E8EAF0', '#A3AAB6', '#8B93A1'
LINE, ACCENT, GREEN, RED = '#30353E', '#93A9EF', '#8FC6A9', '#E7A0A8'
PERSONAL=args.revision=='02'
PALETTE={
    '#101215':'#141617','#1B1F25':'#1E2021','#191C22':'#1B1D1E',
    '#20242B':'#232526','#1D2128':'#202223','#232830':'#292C2D',
    '#282E38':'#2D3031','#282D35':'#2B2E2F','#252A32':'#2B2D2F',
    '#30353E':'#3B3E3F','#303A50':'#44392F','#3B4C76':'#73533D',
    '#566C9E':'#987458','#93A9EF':'#DEB698','#DFE7FF':'#F0D8C6',
    '#DCE5FF':'#F0D8C6','#EDF1FF':'#FFF4E9','#4E618C':'#8B6E55',
    '#30394D':'#44392F','#D8E2FF':'#F0D8C6','#C9CFD9':'#D3D1CF',
}
def color(value):return PALETTE.get(value,value) if PERSONAL else value

def rect(x, y, w, h, fill, radius=0, stroke=None, sw=1):
    fill=color(fill);stroke=color(stroke)
    draw.rounded_rectangle((x,y,x+w,y+h), radius, fill, stroke, sw)
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke or "none"}" stroke-width="{sw}"/>')

def line(points, fill=LINE, width=1):
    fill=color(fill)
    draw.line(points, fill, width)
    svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in points)}" fill="none" stroke="{fill}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')

def circle(x, y, r, fill, stroke=None, sw=1):
    fill=color(fill);stroke=color(stroke)
    draw.ellipse((x-r,y-r,x+r,y+r), fill, stroke, sw)
    svg.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke or "none"}" stroke-width="{sw}"/>')

def text(x,y,value,size=14,color=TEXT,bold=False):
    color=PALETTE.get(color,color) if PERSONAL else color
    path=Path('C:/Windows/Fonts') / ('segoeuib.ttf' if bold else 'segoeui.ttf')
    font=ImageFont.truetype(str(path),size)
    draw.text((x,y),value,font=font,fill=color,anchor='lt')
    svg.append(f'<text x="{x}" y="{y+size*.82}" fill="{color}" font-family="Segoe UI,system-ui,sans-serif" font-size="{size}" font-weight="{600 if bold else 400}">{escape(value)}</text>')

def icon(kind,x,y,color=MUTED,s=20):
    def p(*pts): return [(x+px*s/20,y+py*s/20) for px,py in pts]
    def l(*pts): line(p(*pts),color,2)
    if kind=='hash':
        l((7,3),(5,17));l((14,3),(12,17));l((3,8),(17,8));l((2,13),(16,13))
    elif kind=='chevron': l((6,8),(10,12),(14,8))
    elif kind=='plus': l((10,4),(10,16));l((4,10),(16,10))
    elif kind=='voice':
        l((3,8),(6,8),(10,4),(10,16),(6,12),(3,12),(3,8));l((13,6),(15,9),(15,11),(13,14));l((16,3),(19,8),(19,12),(16,17))
    elif kind=='mic':
        rect(x+7*s/20,y+2*s/20,6*s/20,10*s/20,'#23272F',3,color)
        l((4,9),(4,11),(6,15),(10,16),(14,15),(16,11),(16,9));l((10,16),(10,19));l((7,19),(13,19))
    elif kind=='muted':
        icon('mic',x,y,color,s);l((2,2),(18,18))
    elif kind=='headphones':
        l((3,13),(3,8),(5,4),(10,2),(15,4),(17,8),(17,13));rect(x+2*s/20,y+10*s/20,4*s/20,7*s/20,'#23272F',2,color);rect(x+14*s/20,y+10*s/20,4*s/20,7*s/20,'#23272F',2,color)
    elif kind=='screen':
        rect(x+2*s/20,y+3*s/20,16*s/20,11*s/20,'#23272F',2,color);l((10,14),(10,18));l((6,18),(14,18))
    elif kind=='video': rect(x+1,y+4,12,12,'#23272F',3,color);l((13,8),(18,5),(18,15),(13,12))
    elif kind=='search': circle(x+8,y+8,5,'#20242B',color,2);l((12,12),(17,17))
    elif kind=='send': l((3,3),(18,10),(3,17),(6,10),(18,10));l((6,10),(3,3))
    elif kind=='smile':
        circle(x+10,y+10,8,'#242931',color,2);circle(x+7,y+8,1,color);circle(x+13,y+8,1,color);l((6,12),(8,14),(12,14),(14,12))
    elif kind=='settings':
        circle(x+10,y+10,6,'#23272F',color,2);circle(x+10,y+10,2,'#23272F',color,1)
        for a,b in [((10,0),(10,4)),((10,16),(10,20)),((0,10),(4,10)),((16,10),(20,10)),((3,3),(6,6)),((14,14),(17,17)),((3,17),(6,14)),((14,6),(17,3))]:l(a,b)
    elif kind=='exit': l((3,14),(5,10),(9,8),(13,8),(17,10),(19,14));l((3,14),(6,14),(7,11));l((15,11),(16,14),(19,14))
    elif kind=='home': l((2,9),(10,2),(18,9));l((4,8),(4,17),(8,17),(8,12),(12,12),(12,17),(16,17),(16,8))
    elif kind=='more':
        for offset in [4,10,16]:circle(x+offset,y+10,1.5,color)
    elif kind=='bars':
        for a,b in [(3,14),(8,10),(13,6),(18,2)]:line([(x+a,y+18),(x+a,y+b)],color,2)

def avatar(x,y,initial,bg='#3B465D',r=18,online=False):
    circle(x,y,r,bg)
    text(x-r*.38,y-r*.58,initial,int(r*.92),TEXT,True)
    if online:circle(x+r*.70,y+r*.72,4.5,GREEN,'#1E2229',2)

def button(x,y,w,label,kind=None,fill='#282D36',color=TEXT,border=LINE):
    rect(x,y,w,36,fill,8,border)
    if kind:icon(kind,x+11,y+8,color,18)
    text(x+(37 if kind else 13),y+10,label,13,color,True)

# Application frame and neutral chrome.
rect(0,0,W,H,'#101215')
text(40,24,'TRISCORD  /  PROPOSTA DE DIREÇÃO VISUAL',12,MUTED,True)
text(1192,24,f'{args.revision}  ·  Conversa + chamada',13,MUTED)
rect(40,70,1520,900,'#1B1F25',14,'#343943')
rect(41,85,1518,25,'#1B1F25')
text(61,84,'triscord',13,TEXT,True)
text(671,84,'Amigos  /  Geral',12,SUBTLE)
line([(1442,92),(1453,92)],MUTED)
rect(1487,87,10,10,'#1B1F25',1,MUTED)
line([(1530,87),(1540,97)],MUTED);line([(1540,87),(1530,97)],MUTED)
line([(40,110),(1560,110)])

# Narrow server navigation; one restrained selected treatment.
if PERSONAL:
    # A unified workspace sidebar replaces the borrowed circular server rail.
    rect(41,111,335,858,'#20242B')
    rect(65,135,25,25,'#73533D',7)
    line([(72,142),(84,142),(84,153),(77,153),(73,157),(73,153),(72,153),(72,142)],'#F0D8C6',2)
    text(104,132,'triscord',25,TEXT,True)
    text(66,183,'SEU ESPAÇO',10,SUBTLE,True)
    rect(60,210,296,66,'#282D35',12,LINE)
    avatar(90,243,'A','#6A5143',19)
    text(123,226,'Amigos',16,TEXT,True)
    text(123,250,'5 pessoas · 3 na chamada',11,MUTED)
    icon('chevron',324,235)
    button(60,292,91,'Jogos',fill='#282D35')
    button(159,292,118,'Trabalho',fill='#282D35')
    rect(285,292,71,36,'#282D35',8,LINE);icon('plus',310,300)
    rect(60,350,296,36,'#282D35',8,LINE)
    icon('search',72,358);text(101,361,'Encontrar uma conversa',12,MUTED)
    text(66,418,'CONVERSAS',10,SUBTLE,True);icon('plus',330,414,SUBTLE,16)
    rect(60,446,296,43,'#303A50',10)
    rect(60,458,3,19,'#93A9EF',1)
    icon('hash',75,457,ACCENT);text(108,460,'geral',14,'#DFE7FF',True)
    icon('hash',75,508);text(108,510,'links-e-clipes',14,MUTED)
    icon('hash',75,553);text(108,555,'avisos',14,MUTED)
    text(66,611,'CHAMADAS',10,SUBTLE,True);icon('plus',330,607,SUBTLE,16)
    icon('voice',75,649,GREEN);text(108,651,'Geral',14,TEXT,True)
    rect(310,648,31,22,'#2C3732',6);text(321,653,'3',11,GREEN,True)
    for x,initial,bg in [(124,'C','#48516C'),(156,'D','#5C4B40'),(188,'B','#465C51')]:avatar(x,701,initial,bg,12)
    text(213,695,'vocês estão aqui',11,MUTED)
    button(60,756,296,'Convidar pessoas',fill='#282D35')
    line([(60,818),(356,818)])
    icon('bars',68,838,GREEN,18);text(98,838,'Voz conectada',13,GREEN,True)
    text(98,860,'Geral · Amigos',12,MUTED);text(306,839,'24 ms',11,MUTED)
    rect(60,895,296,58,'#262B34',10)
    avatar(86,924,'C','#48516C',17,True)
    text(113,909,'camargo',13,TEXT,True);text(113,930,'Microfone silenciado',10,MUTED)
    icon('muted',296,914,RED,18);icon('settings',327,914,MUTED,18)
    line([(376,110),(376,970)])
else:
    rect(41,111,71,845,'#191C22')
    rect(54,130,44,44,'#252B36',12)
    icon('home',66,142,TEXT)
    line([(60,189),(92,189)])
    rect(54,207,44,44,'#34415F',12,'#6178B1')
    text(64,220,'A',18,'#DCE5FF',True)
    rect(41,219,3,20,ACCENT,1)
    rect(54,266,44,44,'#2E343D',12)
    text(64,280,'G',17,'#B7C0CF',True)
    rect(54,325,44,44,'#2D3431',12)
    text(64,339,'T',17,'#BDD1C6',True)
    rect(54,397,44,44,'#20242B',12,LINE)
    icon('plus',66,409)
    circle(76,930,18,'#252A32');icon('settings',66,920)
    line([(112,110),(112,970)])

    # Server and channel navigation.
    rect(113,111,263,858,'#20242B')
    text(136,138,'Amigos',18,TEXT,True);icon('chevron',336,141)
    text(136,168,'Seu espaço para ficar junto.',12,MUTED)
    rect(132,205,224,36,'#282D35',8,LINE)
    icon('search',143,213);text(170,216,'Encontrar um canal',12,MUTED)
    text(136,272,'CONVERSAS',10,SUBTLE,True);icon('plus',332,268,SUBTLE,16)
    rect(128,299,232,40,'#303A50',8)
    icon('hash',141,309,ACCENT);text(174,311,'geral',14,'#DFE7FF',True)
    icon('hash',141,356);text(174,358,'links-e-clipes',14,MUTED)
    icon('hash',141,402);text(174,404,'avisos',14,MUTED)
    text(136,466,'CHAMADAS',10,SUBTLE,True);icon('plus',332,462,SUBTLE,16)
    icon('voice',140,502,GREEN);text(174,504,'Geral',14,TEXT,True)
    rect(309,500,36,23,'#2C3732',6);text(320,506,'3',11,GREEN,True)
    for y,name,initial,bg in [(553,'camargo','C','#48516C'),(591,'Diego','D','#5C4B40'),(629,'Bia','B','#465C51')]:
        avatar(167,y,initial,bg,12)
        text(190,y-7,name,13,MUTED)
    icon('muted',330,543,MUTED,16)
    icon('screen',330,581,GREEN,16)
    text(136,704,'CONVITE DO SERVIDOR',10,SUBTLE,True)
    text(136,731,'Uma conversa fica melhor junto.',12,MUTED)
    button(132,758,224,'Convidar pessoas',fill='#282D35')

    # Persistent connection status and account.
    line([(128,818),(360,818)])
    icon('bars',136,838,GREEN,18)
    text(164,838,'Voz conectada',13,GREEN,True)
    text(164,860,'Geral · Amigos',12,MUTED)
    text(314,839,'24 ms',11,MUTED)
    rect(128,895,232,58,'#262B34',10)
    avatar(153,924,'C','#48516C',17,True)
    text(180,909,'camargo',13,TEXT,True);text(180,930,'Microfone silenciado',10,MUTED)
    icon('muted',301,914,RED,18);icon('settings',332,914,MUTED,18)
    line([(376,110),(376,970)])

# Main channel header.
rect(377,111,927,69,'#1D2128')
icon('hash',400,135,SUBTLE,23)
text(438,130,'geral',18,TEXT,True)
text(438,155,'Converse e combine a próxima partida.',12,MUTED)
rect(1000,127,220,36,'#252A32',8,LINE)
icon('search',1011,135);text(1039,138,'Buscar na conversa',12,MUTED)
icon('more',1260,135)
line([(376,180),(1560,180)])

# Call panel: content area separated from messaging, explicit control labels.
rect(396,200,888,298,'#232830',12,LINE)
icon('voice',413,218,GREEN,19)
text(443,218,'Geral',14,TEXT,True)
text(497,220,'3 pessoas na chamada',12,MUTED)
circle(1146,226,3,GREEN);text(1157,219,'Conectado',12,GREEN)
icon('more',1241,215)
rect(412,252,452,174,'#151D23',9,'#39444C')
# An abstract stand-in deliberately avoids claiming an actual game/screen capture.
for pts,c in [([(423,363),(495,303),(565,333),(657,285),(744,348),(853,294)],'#384B51'),([(422,385),(506,343),(573,376),(683,329),(775,371),(854,343)],'#4C615E'),([(424,403),(515,380),(616,394),(703,363),(810,397),(854,383)],'#6C7971')]:line(pts,c,3)
rect(424,264,130,24,'#252D34',6);icon('screen',432,269,TEXT,14);text(453,270,'Tela de Diego',11,TEXT,True)
rect(770,264,82,24,'#252D34',6);text(781,270,'720p · 30 fps',10,MUTED)
rect(424,391,109,23,'#252D34',6);text(435,397,'2 assistindo',10,TEXT)
rect(876,252,190,174,'#2B3039',9,LINE)
avatar(971,326,'C','#48516C',27)
icon('muted',889,398,MUTED,15);text(912,397,'camargo',12,TEXT)
rect(1078,252,190,174,'#29332F',9,'#8FC6A9',2)
avatar(1173,326,'B','#526A5C',27)
icon('bars',1090,397,GREEN,17);text(1115,397,'Bia',12,TEXT)
button(412,444,114,'Silenciado','muted',color=RED)
button(534,444,88,'Áudio','headphones')
button(630,444,99,'Câmera','video')
button(737,444,139,'Compartilhar','screen',fill='#3B4C76',color='#EDF1FF',border='#566C9E')
button(1177,444,91,'Sair','exit',fill='#352A30',color=RED,border='#51363F')

# Chat: a readable flow, not a dashboard of glowing cards.
line([(408,531),(766,531)])
text(783,524,'Hoje',11,SUBTLE)
line([(827,531),(1272,531)])
avatar(430,579,'D','#5C4B40',18)
text(463,560,'Diego',14,TEXT,True);text(516,563,'12:40',11,SUBTLE)
text(463,585,'Alguém por aqui? Vou abrir o jogo agora.',15,'#C9CFD9')
text(463,613,'Se quiserem, compartilho a tela enquanto a gente espera.',15,'#C9CFD9')
avatar(430,675,'B','#465C51',18)
text(463,656,'Bia',14,TEXT,True);text(494,659,'12:41',11,SUBTLE)
text(463,681,'Tô entrando! Deixa no canal Geral que já chego.',15,'#C9CFD9')
rect(463,714,77,27,'#30394D',8,'#4E618C')
text(475,721,'Boa!  2',11,'#D8E2FF')
avatar(430,790,'C','#48516C',18)
text(463,771,'camargo',14,TEXT,True);text(540,774,'12:42',11,SUBTLE)
text(463,796,'Fechado. Já estou aqui com vocês.',15,'#C9CFD9')
text(411,849,'Diego está digitando…',11,MUTED)
rect(396,875,888,62,'#282E38',12,'#3B4350')
icon('plus',415,896,MUTED,22)
text(451,897,'Conversar em #geral',14,MUTED)
icon('smile',1188,896,MUTED,22)
rect(1231,888,40,36,'#3B4C76',8)
icon('send',1242,896,'#EDF1FF',18)
text(411,949,'Enter para enviar  ·  Shift + Enter para nova linha',10,SUBTLE)

# People: supporting information kept quieter than conversation.
rect(1305,181,254,788,'#20242B')
line([(1304,180),(1304,970)])
text(1328,138,'Pessoas',15,TEXT,True)
text(1328,211,'NESTA CHAMADA · 3',10,SUBTLE,True)
for y,name,initial,bg,status in [(265,'camargo','C','#48516C','Microfone silenciado'),(330,'Diego','D','#5C4B40','Compartilhando tela'),(395,'Bia','B','#465C51','Falando agora')]:
    avatar(1347,y,initial,bg,17,True)
    text(1375,y-16,name,13,TEXT,True)
    text(1375,y+5,status,10,GREEN if name=='Bia' else MUTED)
text(1328,461,'ONLINE · 2',10,SUBTLE,True)
for y,name,initial,bg in [(511,'Rafa','R','#4A5260'),(566,'Lucas','L','#574E60')]:
    avatar(1347,y,initial,bg,17,True);text(1375,y-8,name,13,MUTED)

text(40,999,'Proposta para revisão · conteúdo ilustrativo · nenhum aplicativo ou dispositivo foi executado',12,MUTED)
text(1137,999,'Identidade própria. Sem excesso visual.',12,MUTED)
svg.append('</svg>')
(args.output/'main-screen.svg').write_text('\n'.join(svg),encoding='utf-8')
image.save(args.output/'main-screen.png')
print('Saved main-screen.svg and main-screen.png')
