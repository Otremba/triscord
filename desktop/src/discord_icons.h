#pragma once

#include <QIcon>
#include <QPixmap>
#include <QPainter>
#include <QPainterPath>
#include <QColor>
#include <QRectF>

namespace triscord {

class DiscordIcons {
public:
    enum class IconType {
        Microphone,         // Módulo 831544
        MicrophoneMuted,    // Módulo 83107
        Headphones,         // Módulo 597601
        HeadphonesDeafened, // Módulo 990836
        Settings,           // Módulo 625903
        Camera,             // Módulo 332461
        ScreenShare,        // Módulo 31300
        Disconnect,         // Módulo 960027
        VoiceSpeaker,       // Módulo 983851
        Close,              // Vetor ✕ para fechar/desconectar
        Fullscreen,         // Módulo 186934
        PictureInPicture,   // Popout / PiP
        ChevronSmallDown,   // Módulo 847374
        ChevronSmallUp,     // Módulo 900797
        ChevronSmallRight,  // Módulo 320448
        PlusSmall,          // Módulo 307301
        Video,              // Módulo 428689
        ScreenArrow,        // Módulo 183623
        Soundboard,         // Módulo 7807
        VideoSlash,         // Módulo 943812
        ConnectionFine,     // Módulo 200192
        WindowLaunch,       // Módulo 811893
        Copy,               // Módulo 624479
        Trash,              // Módulo 241326
        User,               // Módulo 950305
        PaintPalette,       // Módulo 650809
        DoorExit,           // Módulo 70688
        CircleCheck,        // Módulo 628284
        Play,               // Módulo 782134
        Chat,               // Módulo 534890
        Bell,               // Módulo 782603
        Pencil,              // Módulo 22231
        MagnifyingGlass,     // Módulo 7689
        Reaction,            // Módulo 460905
        MoreHorizontal,      // Módulo 365199
        Browser,             // Módulo 93688
        ScreenX,             // Parar transmissão
        MagnifyingGlassPlus, // Módulo 218429
        Group,               // Módulo 177953
        CirclePlus,          // Módulo 245604 ("Adicionar um servidor")
        UserPlus,            // Módulo 283973 (convite no cabeçalho do servidor)
        Pin,                 // Módulo 788120 ("Mostrar sempre" na janela destacada)
        PinSlash             // Módulo 609731 ("Remover do topo" na janela destacada)
    };

    // Gera um QPixmap com o ícone renderizado nas dimensões solicitadas
    static QPixmap pixmap(IconType type, const QColor& color, int size = 20, int devicePixelRatio = 1);

    // Gera um QIcon vetorial com o ícone renderizado
    static QIcon icon(IconType type, const QColor& color, int size = 20);

    // Gera um QIcon de alternância (normal vs active/checked com cores distintas)
    static QIcon toggleIcon(IconType normalType, const QColor& normalColor,
                            IconType checkedType, const QColor& checkedColor,
                            int size = 20);

    // Pinta diretamente em um QPainter (ex: no badge do ParticipantPane)
    static void paint(QPainter* painter, IconType type, const QRectF& rect, const QColor& color);

    // Retorna o QPainterPath base (normalizado na escala 24x24)
    static QPainterPath path(IconType type);

    // Parser universal de caminhos SVG (d="...") para QPainterPath
    static QPainterPath parseSvgPath(const QString& d);
};

} // namespace triscord
