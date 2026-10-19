#include "discord_icons.h"
#include <cmath>
#include <algorithm>
#include <cctype>
#include <QPainter>
#include <QtMath>
#include <QDebug>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace triscord {

namespace {

void addArcToPath(QPainterPath& path, qreal x0, qreal y0,
                  qreal rx, qreal ry, qreal xAxisRotationDeg,
                  bool largeArcFlag, bool sweepFlag,
                  qreal x1, qreal y1) {
    if (rx <= 0.0 || ry <= 0.0 || (qFuzzyCompare(x0, x1) && qFuzzyCompare(y0, y1))) {
        path.lineTo(x1, y1);
        return;
    }
    rx = std::abs(rx);
    ry = std::abs(ry);

    const qreal phi = qDegreesToRadians(xAxisRotationDeg);
    const qreal cosPhi = std::cos(phi);
    const qreal sinPhi = std::sin(phi);

    const qreal dx2 = (x0 - x1) / 2.0;
    const qreal dy2 = (y0 - y1) / 2.0;
    const qreal x1p = cosPhi * dx2 + sinPhi * dy2;
    const qreal y1p = -sinPhi * dx2 + cosPhi * dy2;

    qreal lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1.0) {
        qreal sqLambda = std::sqrt(lambda);
        rx *= sqLambda;
        ry *= sqLambda;
    }

    qreal sign = (largeArcFlag == sweepFlag) ? -1.0 : 1.0;
    qreal num = (rx * rx * ry * ry) - (rx * rx * y1p * y1p) - (ry * ry * x1p * x1p);
    qreal den = (rx * rx * y1p * y1p) + (ry * ry * x1p * x1p);
    qreal factor = 0.0;
    if (den > 0.0 && num > 0.0) {
        factor = sign * std::sqrt(num / den);
    }
    const qreal cxp = factor * (rx * y1p / ry);
    const qreal cyp = factor * (-ry * x1p / rx);

    const qreal cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2.0;
    const qreal cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2.0;

    auto angleBetween = [](qreal ux, qreal uy, qreal vx, qreal vy) -> qreal {
        qreal dot = ux * vx + uy * vy;
        qreal len = std::sqrt(ux * ux + uy * uy) * std::sqrt(vx * vx + vy * vy);
        if (len <= 0.0) return 0.0;
        qreal val = dot / len;
        val = std::clamp(val, -1.0, 1.0);
        qreal ang = std::acos(val);
        if ((ux * vy - uy * vx) < 0.0) ang = -ang;
        return ang;
    };

    const qreal theta1 = angleBetween(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    qreal dtheta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry,
                                (-x1p - cxp) / rx, (-y1p - cyp) / ry);

    if (!sweepFlag && dtheta > 0.0) dtheta -= 2.0 * M_PI;
    else if (sweepFlag && dtheta < 0.0) dtheta += 2.0 * M_PI;

    int segments = std::max(1, static_cast<int>(std::ceil(std::abs(dtheta) / (M_PI / 2.0))));
    qreal delta = dtheta / segments;

    qreal currentTheta = theta1;
    for (int i = 0; i < segments; ++i) {
        qreal nextTheta = currentTheta + delta;
        qreal halfDelta = delta / 2.0;
        qreal alpha = std::sin(delta) * (std::sqrt(4.0 + 3.0 * std::pow(std::tan(halfDelta), 2.0)) - 1.0) / 3.0;

        qreal cos1 = std::cos(currentTheta);
        qreal sin1 = std::sin(currentTheta);
        qreal cos2 = std::cos(nextTheta);
        qreal sin2 = std::sin(nextTheta);

        qreal ep0x = rx * cos1;
        qreal ep0y = ry * sin1;
        qreal ep3x = rx * cos2;
        qreal ep3y = ry * sin2;

        qreal ep1x = ep0x - alpha * rx * sin1;
        qreal ep1y = ep0y + alpha * ry * cos1;
        qreal ep2x = ep3x + alpha * rx * sin2;
        qreal ep2y = ep3y - alpha * ry * cos2;

        auto rotateAndTranslate = [&](qreal x, qreal y) -> QPointF {
            return QPointF(cosPhi * x - sinPhi * y + cx,
                           sinPhi * x + cosPhi * y + cy);
        };

        QPointF p1 = rotateAndTranslate(ep1x, ep1y);
        QPointF p2 = rotateAndTranslate(ep2x, ep2y);
        QPointF p3 = rotateAndTranslate(ep3x, ep3y);

        path.cubicTo(p1, p2, p3);
        currentTheta = nextTheta;
    }
}

} // namespace

QPainterPath DiscordIcons::parseSvgPath(const QString& d) {
    QPainterPath path;
    const std::string s = d.toStdString();
    size_t i = 0;
    const size_t len = s.length();

    qreal curX = 0.0;
    qreal curY = 0.0;
    qreal startX = 0.0;
    qreal startY = 0.0;
    char currentCmd = '\0';

    auto skipWhitespaceAndCommas = [&]() {
        while (i < len && (std::isspace(s[i]) || s[i] == ',')) {
            i++;
        }
    };

    auto readNumber = [&](qreal& outNum) -> bool {
        skipWhitespaceAndCommas();
        if (i >= len) return false;

        const size_t start = i;
        if (s[i] == '+' || s[i] == '-') i++;
        bool hasDigits = false;
        while (i < len && std::isdigit(s[i])) {
            hasDigits = true;
            i++;
        }
        if (i < len && s[i] == '.') {
            i++;
            while (i < len && std::isdigit(s[i])) {
                hasDigits = true;
                i++;
            }
        }
        if (hasDigits && i < len && (s[i] == 'e' || s[i] == 'E')) {
            i++;
            if (i < len && (s[i] == '+' || s[i] == '-')) i++;
            while (i < len && std::isdigit(s[i])) i++;
        }
        if (!hasDigits) {
            i = start;
            return false;
        }
        try {
            outNum = std::stod(s.substr(start, i - start));
            return true;
        } catch (...) {
            i = start;
            return false;
        }
    };

    while (i < len) {
        skipWhitespaceAndCommas();
        if (i >= len) break;

        char c = s[i];
        if (std::isalpha(c)) {
            currentCmd = c;
            i++;
        }

        switch (currentCmd) {
            case 'M': {
                qreal x, y;
                if (readNumber(x) && readNumber(y)) {
                    curX = x; curY = y;
                    startX = curX; startY = curY;
                    path.moveTo(curX, curY);
                    // Subsequent coordinate pairs are treated as implicit lineTo
                    while (readNumber(x) && readNumber(y)) {
                        curX = x; curY = y;
                        path.lineTo(curX, curY);
                    }
                }
                break;
            }
            case 'm': {
                qreal dx, dy;
                if (readNumber(dx) && readNumber(dy)) {
                    curX += dx; curY += dy;
                    startX = curX; startY = curY;
                    path.moveTo(curX, curY);
                    while (readNumber(dx) && readNumber(dy)) {
                        curX += dx; curY += dy;
                        path.lineTo(curX, curY);
                    }
                }
                break;
            }
            case 'L': {
                qreal x, y;
                while (readNumber(x) && readNumber(y)) {
                    curX = x; curY = y;
                    path.lineTo(curX, curY);
                }
                break;
            }
            case 'l': {
                qreal dx, dy;
                while (readNumber(dx) && readNumber(dy)) {
                    curX += dx; curY += dy;
                    path.lineTo(curX, curY);
                }
                break;
            }
            case 'H': {
                qreal x;
                while (readNumber(x)) {
                    curX = x;
                    path.lineTo(curX, curY);
                }
                break;
            }
            case 'h': {
                qreal dx;
                while (readNumber(dx)) {
                    curX += dx;
                    path.lineTo(curX, curY);
                }
                break;
            }
            case 'V': {
                qreal y;
                while (readNumber(y)) {
                    curY = y;
                    path.lineTo(curX, curY);
                }
                break;
            }
            case 'v': {
                qreal dy;
                while (readNumber(dy)) {
                    curY += dy;
                    path.lineTo(curX, curY);
                }
                break;
            }
            case 'C': {
                qreal x1, y1, x2, y2, x, y;
                while (readNumber(x1) && readNumber(y1) &&
                       readNumber(x2) && readNumber(y2) &&
                       readNumber(x)  && readNumber(y)) {
                    path.cubicTo(x1, y1, x2, y2, x, y);
                    curX = x; curY = y;
                }
                break;
            }
            case 'c': {
                qreal dx1, dy1, dx2, dy2, dx, dy;
                while (readNumber(dx1) && readNumber(dy1) &&
                       readNumber(dx2) && readNumber(dy2) &&
                       readNumber(dx)  && readNumber(dy)) {
                    path.cubicTo(curX + dx1, curY + dy1,
                                 curX + dx2, curY + dy2,
                                 curX + dx,  curY + dy);
                    curX += dx; curY += dy;
                }
                break;
            }
            case 'A': {
                qreal rx, ry, rot, large, sweep, x, y;
                while (readNumber(rx) && readNumber(ry) && readNumber(rot) &&
                       readNumber(large) && readNumber(sweep) &&
                       readNumber(x) && readNumber(y)) {
                    addArcToPath(path, curX, curY, rx, ry, rot,
                                 large != 0.0, sweep != 0.0, x, y);
                    curX = x; curY = y;
                }
                break;
            }
            case 'a': {
                qreal rx, ry, rot, large, sweep, dx, dy;
                while (readNumber(rx) && readNumber(ry) && readNumber(rot) &&
                       readNumber(large) && readNumber(sweep) &&
                       readNumber(dx) && readNumber(dy)) {
                    addArcToPath(path, curX, curY, rx, ry, rot,
                                 large != 0.0, sweep != 0.0, curX + dx, curY + dy);
                    curX += dx; curY += dy;
                }
                break;
            }
            case 'Z':
            case 'z': {
                path.closeSubpath();
                curX = startX; curY = startY;
                break;
            }
            default:
                i++;
                break;
        }
    }
    return path;
}

QPainterPath DiscordIcons::path(IconType type) {
    switch (type) {
        case IconType::Microphone:
            // Discord module 831544
            return parseSvgPath("M12 2a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Z "
                                "M6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.94V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z");

        case IconType::MicrophoneMuted:
            // Discord module 83107
            return parseSvgPath("m2.7 22.7 20-20a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4ZM10.8 17.32c-.21.21-.1.58.2.62V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 10a1 1 0 0 0-2 0c0 1.45-.52 2.79-1.38 3.83l-.02.02A5.99 5.99 0 0 1 12.32 16a.52.52 0 0 0-.34.15l-1.18 1.18ZM15.36 4.52c.15-.15.19-.38.08-.56A4 4 0 0 0 8 6v4c0 .3.03.58.1.86.07.34.49.43.74.18l6.52-6.52ZM5.06 13.98c.16.28.53.31.75.09l.75-.75c.16-.16.19-.4.08-.61A5.97 5.97 0 0 1 6 10a1 1 0 0 0-2 0c0 1.45.39 2.81 1.06 3.98Z");

        case IconType::Headphones:
            // Discord module 597601
            return parseSvgPath("M12 3a9 9 0 0 0-8.95 10h1.87a5 5 0 0 1 4.1 2.13l1.37 1.97a3.1 3.1 0 0 1-.17 3.78 2.85 2.85 0 0 1-3.55.74 11 11 0 1 1 10.66 0c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86A9 9 0 0 0 12 3Z");

        case IconType::HeadphonesDeafened:
            // Discord module 990836
            return parseSvgPath("M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4l20-20ZM17.06 2.94a.48.48 0 0 0-.11-.77A11 11 0 0 0 2.18 16.94c.14.3.53.35.76.12l3.2-3.2c.25-.25.15-.68-.2-.76a5 5 0 0 0-1.02-.1H3.05a9 9 0 0 1 12.66-9.2c.2.09.44.05.59-.1l.76-.76ZM20.2 8.28a.52.52 0 0 1 .1-.58l.76-.76a.48.48 0 0 1 .77.11 11 11 0 0 1-4.5 14.57c-1.27.71-2.73.23-3.55-.74a3.1 3.1 0 0 1-.17-3.78l1.38-1.97a5 5 0 0 1 4.1-2.13h1.86a9.1 9.1 0 0 0-.75-4.72ZM10.1 17.9c.25-.25.65-.18.74.14a3.1 3.1 0 0 1-.62 2.84 2.85 2.85 0 0 1-3.55.74.16.16 0 0 1-.04-.25l3.48-3.48Z");

        case IconType::Settings:
            // Discord module 625903
            return parseSvgPath("M10.56 1.1c-.46.05-.7.53-.64.98.18 1.16-.19 2.2-.98 2.53-.8.33-1.79-.15-2.49-1.1-.27-.36-.78-.52-1.14-.24-.77.59-1.45 1.27-2.04 2.04-.28.36-.12.87.24 1.14.96.7 1.43 1.7 1.1 2.49-.33.8-1.37 1.16-2.53.98-.45-.07-.93.18-.99.64a11.1 11.1 0 0 0 0 2.88c.06.46.54.7.99.64 1.16-.18 2.2.19 2.53.98.33.8-.14 1.79-1.1 2.49-.36.27-.52.78-.24 1.14.59.77 1.27 1.45 2.04 2.04.36.28.87.12 1.14-.24.7-.95 1.7-1.43 2.49-1.1.8.33 1.16 1.37.98 2.53-.07.45.18.93.64.99a11.1 11.1 0 0 0 2.88 0c.46-.06.7-.54.64-.99-.18-1.16.19-2.2.98-2.53.8-.33 1.79.14 2.49 1.1.27.36.78.52 1.14.24.77-.59 1.45-1.27 2.04-2.04.28-.36.12-.87-.24-1.14-.96-.7-1.43-1.7-1.1-2.49.33-.8 1.37-1.16 2.53-.98.45.07.93-.18.99-.64a11.1 11.1 0 0 0 0-2.88c-.06-.46-.54-.7-.99-.64-1.16.18-2.2-.19-2.53-.98-.33-.8.14-1.79 1.1-2.49.36-.27.52-.78.24-1.14a11.07 11.07 0 0 0-2.04-2.04c-.36-.28-.87-.12-1.14.24-.7.96-1.7 1.43-2.49 1.1-.8-.33-1.16-1.37-.98-2.53.07-.45-.18-.93-.64-.99a11.1 11.1 0 0 0-2.88 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z");

        case IconType::Camera:
            // Discord module 332461
            return parseSvgPath("M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z "
                                "M7.17 4.66A3 3 0 0 1 9.85 3h4.3a3 3 0 0 1 2.68 1.66c.34.69.94 1.34 1.71 1.34H20a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h1.46c.77 0 1.37-.65 1.71-1.34ZM17 13a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z");

        case IconType::ScreenShare:
            // Discord module 31300
            return parseSvgPath("M5 2a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5ZM13.5 20a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 0-.5-.5h-1a.5.5 0 0 0-.5.5v2a.5.5 0 0 1-.5.5H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-1.5Z");

        case IconType::Disconnect:
            // Discord module 960027
            return parseSvgPath("m21.5 16.6-.13.14a.88.88 0 0 1-.97.2l-4.09-1.7a.99.99 0 0 1-.57-1.18l.73-2.7c-2.24-3-6.7-3-8.94 0l.7 2.1a.99.99 0 0 1-.48 1.19l-4.13 2.2a.87.87 0 0 1-1.03-.15l-.1-.1a5.18 5.18 0 0 1-.32-6.92 12.67 12.67 0 0 1 19.66 0 5.18 5.18 0 0 1-.32 6.92Z");

        case IconType::VoiceSpeaker:
            // Discord module 983851
            return parseSvgPath("M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z "
                                "M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z");

        case IconType::Close:
            // Discord module 789645 (XSmallIcon)
            return parseSvgPath("M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z");

        case IconType::Fullscreen:
            // Discord module 186934 (FullscreenEnterIcon)
            return parseSvgPath("M3 5a2 2 0 0 1 2-2h4a1 1 0 0 1 0 2H5v4a1 1 0 0 1-2 0V5Zm16-2a2 2 0 0 1 2 2v4a1 1 0 1 1-2 0V5h-4a1 1 0 1 1 0-2h4ZM3 19a2 2 0 0 0 2 2h4a1 1 0 1 0 0-2H5v-4a1 1 0 1 0-2 0v4Zm18 0a2 2 0 0 1-2 2h-4a1 1 0 1 1 0-2h4v-4a1 1 0 1 1 2 0v4Z");

        case IconType::PictureInPicture:
            // Discord Popout / Picture-in-picture icon
            return parseSvgPath("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 0v14h14V5H5Zm8 6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4Z");

        case IconType::ChevronSmallDown:
            // Discord module 847374 (ChevronSmallDownIcon), web.b19183c9af96925c.js offset 10066064
            return parseSvgPath("M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z");

        case IconType::ChevronSmallUp:
            // Discord module 900797 (ChevronSmallUpIcon), web.b19183c9af96925c.js offset 10067781
            return parseSvgPath("M5.3 14.7a1 1 0 0 0 1.4 0L12 9.42l5.3 5.3a1 1 0 0 0 1.4-1.42l-6-6a1 1 0 0 0-1.4 0l-6 6a1 1 0 0 0 0 1.42Z");

        case IconType::ChevronSmallRight:
            // Discord module 320448 (ChevronSmallRightIcon), web.b19183c9af96925c.js offset 10067209
            return parseSvgPath("M9.3 5.3a1 1 0 0 0 0 1.4l5.29 5.3-5.3 5.3a1 1 0 1 0 1.42 1.4l6-6a1 1 0 0 0 0-1.4l-6-6a1 1 0 0 0-1.42 0Z");

        case IconType::PlusSmall:
            // Discord module 307301 (PlusSmallIcon), web.b19183c9af96925c.js offset 10249368
            return parseSvgPath("M13 6a1 1 0 1 0-2 0v5H6a1 1 0 1 0 0 2h5v5a1 1 0 1 0 2 0v-5h5a1 1 0 1 0 0-2h-5V6Z");

        case IconType::Video:
            // Discord module 428689 (VideoIcon), web.b19183c9af96925c.js offset 10367594
            return parseSvgPath("M4 4a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-2.12a1 1 0 0 0 .55.9l3 1.5a1 1 0 0 0 1.45-.9V7.62a1 1 0 0 0-1.45-.9l-3 1.5a1 1 0 0 0-.55.9V7a3 3 0 0 0-3-3H4Z");

        case IconType::ScreenArrow:
            // Discord module 183623 (ScreenArrowIcon), web.b19183c9af96925c.js offsets 10275664 and 10275972
            return parseSvgPath("M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm16 3a1 1 0 0 0-.3-.7l-3-3a1 1 0 1 0-1.4 1.4L14.58 7H13a6 6 0 0 0-6 6 1 1 0 1 0 2 0 4 4 0 0 1 4-4h1.59l-1.3 1.3a1 1 0 0 0 1.42 1.4l3-3A1 1 0 0 0 18 8Z "
                                "M13 19.5c0 .28.22.5.5.5H15a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h1.5a.5.5 0 0 0 .5-.5v-2c0-.28.22-.5.5-.5h1c.28 0 .5.22.5.5v2Z");

        case IconType::Chat:
            // Discord module 534890 (ChatIcon), web.b19183c9af96925c.js offset 10054070
            return parseSvgPath("M12 22a10 10 0 1 0-8.45-4.64c.13.19.11.44-.04.61l-2.06 2.37A1 1 0 0 0 2.2 22H12Z");

        case IconType::Bell:
            // Discord module 782603 (BellIcon), web.b19183c9af96925c.js offset 10018078
            return parseSvgPath("M9.7 2.89c.18-.07.32-.24.37-.43a2 2 0 0 1 3.86 0c.05.2.19.36.38.43A7 7 0 0 1 19 9.5v2.09c0 .12.05.24.13.33l1.1 1.22a3 3 0 0 1 .77 2.01v.28c0 .67-.34 1.29-.95 1.56-1.31.6-4 1.51-8.05 1.51-4.05 0-6.74-.91-8.05-1.5-.61-.28-.95-.9-.95-1.57v-.28a3 3 0 0 1 .77-2l1.1-1.23a.5.5 0 0 0 .13-.33V9.5a7 7 0 0 1 4.7-6.61ZM9.18 19.84A.16.16 0 0 0 9 20a3 3 0 1 0 6 0c0-.1-.09-.17-.18-.16a24.86 24.86 0 0 1-5.64 0Z");

        case IconType::Pencil:
            // Discord module 22231 (PencilIcon), web.b19183c9af96925c.js offset 10240026
            return parseSvgPath("m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z");

        case IconType::MagnifyingGlass:
            // Discord module 7689 (MagnifyingGlassIcon), web.b19183c9af96925c.js offset 10202140
            return parseSvgPath("M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z");

        case IconType::Reaction:
            // Discord module 460905 (ReactionIcon), web.b19183c9af96925c.js offset 10258385
            return parseSvgPath("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22ZM6.5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-9.8 1.17a1 1 0 0 1 1.39.27 3.5 3.5 0 0 0 5.82 0 1 1 0 0 1 1.66 1.12 5.5 5.5 0 0 1-9.14 0 1 1 0 0 1 .27-1.4Z");

        case IconType::MoreHorizontal:
            // Discord module 365199 (MoreHorizontalIcon), web.b19183c9af96925c.js offset 10215837
            return parseSvgPath("M4 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z");

        case IconType::Browser:
            // Discord module 93688 (BrowserIcon), web.b19183c9af96925c.js offset 10039150
            return parseSvgPath("M20 3a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h16ZM4 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z");

        case IconType::ScreenX:
            // Discord ScreenXIcon (screen with an X), web.b19183c9af96925c.js offsets 10281189 and 10281510
            return parseSvgPath("M2 5a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Zm6.3.3a1 1 0 0 1 1.4 0L12 7.58l2.3-2.3a1 1 0 1 1 1.4 1.42L13.42 9l2.3 2.3a1 1 0 0 1-1.42 1.4L12 10.42l-2.3 2.3a1 1 0 0 1-1.4-1.42L10.58 9l-2.3-2.3a1 1 0 0 1 0-1.4ZM13 19.5c0 .28.22.5.5.5H15a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h1.5a.5.5 0 0 0 .5-.5v-2c0-.28.22-.5.5-.5h1c.28 0 .5.22.5.5v2Z");

        case IconType::MagnifyingGlassPlus:
            // Discord module 218429 (MagnifyingGlassPlusIcon), web.b19183c9af96925c.js offsets 10203504 and 10203703
            return parseSvgPath("M15.62 17.03a9 9 0 1 1 1.41-1.41l4.68 4.67a1 1 0 0 1-1.42 1.42l-4.67-4.68ZM17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M11 7a1 1 0 1 0-2 0v2H7a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2h-2V7Z");

        case IconType::Group:
            // Discord module 177953 (GroupIcon), web.b19183c9af96925c.js offset 10155355
            return parseSvgPath("M14.5 8a3 3 0 1 0-2.7-4.3c-.2.4.06.86.44 1.12a5 5 0 0 1 2.14 3.08c.01.06.06.1.12.1ZM18.44 17.27c.15.43.54.73 1 .73h1.06c.83 0 1.5-.67 1.5-1.5a7.5 7.5 0 0 0-6.5-7.43c-.55-.08-.99.38-1.1.92-.06.3-.15.6-.26.87-.23.58-.05 1.3.47 1.63a9.53 9.53 0 0 1 3.83 4.78ZM12.5 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM2 20.5a7.5 7.5 0 0 1 15 0c0 .83-.67 1.5-1.5 1.5a.2.2 0 0 1-.2-.16c-.2-.96-.56-1.87-.88-2.54-.1-.23-.42-.15-.42.1v2.1a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-2.1c0-.25-.31-.33-.42-.1-.32.67-.67 1.58-.88 2.54a.2.2 0 0 1-.2.16A1.5 1.5 0 0 1 2 20.5Z");

        case IconType::CirclePlus:
            // Discord module 245604 (CirclePlusIcon), decoded web bundle f_0000d3 (SHA-256 d49a5209...) offset 10127088
            return parseSvgPath("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm0-17a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H7a1 1 0 1 1 0-2h4V7a1 1 0 0 1 1-1Z");

        case IconType::Pin:
            // Discord module 788120 (stay-on-top button module 619344, "Mostrar sempre"), decoded web bundle f_00000a
            return parseSvgPath("M16.91 5C18.61 5 20 3.48 20 1.6v-.1a.5.5 0 0 0-.5-.5h-15a.5.5 0 0 0-.5.5v.1C4 3.49 5.38 5 7.09 5H8v4.35l-3.39 3.26A2 2 0 0 0 4 14.05V15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-.95a2 2 0 0 0-.61-1.44L16 9.35V5h.91ZM13.37 17.25c.33 0 .56.3.5.61l-1.08 4.75a.5.5 0 0 1-.49.39h-.6a.5.5 0 0 1-.49-.39l-1.07-4.75a.5.5 0 0 1 .49-.61h2.74Z");

        case IconType::PinSlash:
            // Discord module 609731 (stay-on-top button module 619344, "Remover do topo"), decoded web bundle f_00000a
            return parseSvgPath("M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4l20-20ZM4.5 1h13.17a.5.5 0 0 1 .36.85L4.62 15.25c-.2.22-.56.2-.6-.1A1 1 0 0 1 4 15v-.95a2 2 0 0 1 .61-1.44L8 9.35V5h-.91C5.39 5 4 3.48 4 1.6v-.1c0-.28.22-.5.5-.5ZM17.77 11.05a.5.5 0 0 0-.7 0l-4.1 4.1a.5.5 0 0 0 .36.85H19a1 1 0 0 0 1-1v-.95a2 2 0 0 0-.61-1.44l-1.62-1.56ZM11.08 17.25a.5.5 0 0 0-.36.15l-.36.37a.5.5 0 0 0-.14.46l.99 4.38a.5.5 0 0 0 .49.39h.6a.5.5 0 0 0 .49-.39l1.07-4.75a.5.5 0 0 0-.49-.61h-2.3Z");

        case IconType::UserPlus:
            // Discord module 283973 (UserPlusIcon), decoded web bundle f_0000d3 (SHA-256 d49a5209...) offset 10419484
            return parseSvgPath("M19 14a1 1 0 0 1 1 1v3h3a1 1 0 0 1 0 2h-3v3a1 1 0 0 1-2 0v-3h-3a1 1 0 1 1 0-2h3v-3a1 1 0 0 1 1-1Z"
                                "M16.83 12.93c.26-.27.26-.75-.08-.92A9.5 9.5 0 0 0 12.47 11h-.94A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.26 2.61c-.02.3.2.55.5.55h7.64c.12 0 .17-.31.06-.36C12.82 21.14 12 20.22 12 19a3 3 0 0 1 3-3h.5a.5.5 0 0 0 .5-.5V15c0-.8.31-1.53.83-2.07ZM12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z");

        case IconType::VideoSlash:
            // Discord module 943812 (VideoSlashIcon), cache asset b_2b7fbb9225329f4b (camera off in the voice panel)
            return parseSvgPath("M22.7 2.7a1 1 0 0 0-1.4-1.4l-20 20a1 1 0 1 0 1.4 1.4l20-20ZM9.2 20a.5.5 0 0 1-.35-.85l12.1-12.1a.5.5 0 0 1 .12-.09l.48-.24a1 1 0 0 1 1.45.9v8.76a1 1 0 0 1-1.45.9l-3-1.5a1 1 0 0 1-.55-.9V17a3 3 0 0 1-3 3H9.2ZM15.28 4.72c.27-.27.15-.71-.23-.72H4a3 3 0 0 0-3 3v10a3 3 0 0 0 .17.99c.1.3.49.35.72.12l13.4-13.4Z");

        case IconType::ConnectionFine:
            // Discord module 200192 (ConnectionFineIcon), cache asset b_abf840ee86e89484 (voice panel signal)
            return parseSvgPath("M2 3a1 1 0 0 1 1-1 19 19 0 0 1 19 19 1 1 0 1 1-2 0A17 17 0 0 0 3 4a1 1 0 0 1-1-1Z"
                                "M2 8a1 1 0 0 1 1-1 14 14 0 0 1 14 14 1 1 0 1 1-2 0A12 12 0 0 0 3 9a1 1 0 0 1-1-1Z"
                                "M3 12a1 1 0 1 0 0 2 7 7 0 0 1 7 7 1 1 0 1 0 2 0 9 9 0 0 0-9-9ZM2 17.83c0-.46.37-.83.83-.83C5.13 17 7 18.87 7 21.17c0 .46-.37.83-.83.83H3a1 1 0 0 1-1-1v-3.17Z");

        case IconType::WindowLaunch:
            // Discord module 811893 (WindowLaunchIcon), cache asset b_d6852e1bd2ccb3f6 (call view pop-out)
            return parseSvgPath("M15 2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V4.41l-4.3 4.3a1 1 0 1 1-1.4-1.42L19.58 3H16a1 1 0 0 1-1-1Z"
                                "M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-6a1 1 0 1 0-2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6a1 1 0 1 0 0-2H5Z");

        case IconType::Copy:
            // Discord module 624479 (CopyIcon), recovered from the cached main bundle (message menu "Copiar texto")
            return parseSvgPath("M3 16a1 1 0 0 1-1-1v-5a8 8 0 0 1 8-8h5a1 1 0 0 1 1 1v.5a.5.5 0 0 1-.5.5H10a6 6 0 0 0-6 6v5.5a.5.5 0 0 1-.5.5H3Z"
                                "M6 18a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-4h-3a5 5 0 0 1-5-5V6h-4a4 4 0 0 0-4 4v8Z"
                                "M21.73 12a3 3 0 0 0-.6-.88l-4.25-4.24a3 3 0 0 0-.88-.61V9a3 3 0 0 0 3 3h2.73Z");

        case IconType::Trash:
            // Discord module 241326 (TrashIcon), recovered from the cached main bundle (message menu "Excluir mensagem")
            return parseSvgPath("M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z"
                                "M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z");

        case IconType::User:
            // Discord module 950305 (UserIcon), cache asset b_3eb0034376a42060 (settings "Conta")
            return parseSvgPath("M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM11.53 11A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.26 2.61c-.02.3.2.55.5.55h11.7a.5.5 0 0 0 .5-.55l-.27-2.6c-.02-.26.27-.37.41-.16.48.74 1.03 1.8 1.32 2.9.06.24.26.41.5.41h.22c.81 0 1.47-.66 1.47-1.47A9.53 9.53 0 0 0 12.47 11h-.94Z");

        case IconType::PaintPalette:
            // Discord module 650809 (PaintPaletteIcon), main bundle (settings "Aparência")
            return parseSvgPath("M19 16h-5a2 2 0 0 0-2 2v2c0 1.66-1.37 3.04-2.96 2.6A11 11 0 1 1 23 12c0 2.2-2 4-4 4ZM13.5 4.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM17.25 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm-9-1.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-3.75 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z");

        case IconType::DoorExit:
            // Discord module 70688 (DoorExitIcon), cache asset b_0ca1e52758d7a8e7 (settings "Sair")
            return parseSvgPath("M9 12a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z"
                                "M2.75 3.02A3 3 0 0 1 5 2h10a3 3 0 0 1 3 3v7.64c0 .44-.55.7-.95.55a3 3 0 0 0-3.17 4.93l.02.03a.5.5 0 0 1-.35.85h-.05a.5.5 0 0 0-.5.5 2.5 2.5 0 0 1-3.68 2.2l-5.8-3.09A3 3 0 0 1 2 16V5a3 3 0 0 1 .76-1.98Zm1.3 1.95A.04.04 0 0 0 4 5v11c0 .36.2.68.49.86l5.77 3.08a.5.5 0 0 0 .74-.44V8.02a.5.5 0 0 0-.32-.46l-6.63-2.6Z"
                                "M15.3 16.7a1 1 0 0 1 1.4-1.4l4.3 4.29V16a1 1 0 1 1 2 0v6a1 1 0 0 1-1 1h-6a1 1 0 1 1 0-2h3.59l-4.3-4.3Z");

        case IconType::CircleCheck:
            // Discord module 628284 (CircleCheckIcon), main bundle (selected theme swatch)
            return parseSvgPath("M12 23a11 11 0 1 0 0-22 11 11 0 0 0 0 22Zm5.7-13.3a1 1 0 0 0-1.4-1.4L10 14.58l-2.3-2.3a1 1 0 0 0-1.4 1.42l3 3a1 1 0 0 0 1.4 0l7-7Z");

        case IconType::Play:
            // Discord module 782134 (PlayIcon), cache asset b_a40042c65c187b84 (soundboard tile overlay)
            return parseSvgPath("M9.25 3.35C7.87 2.45 6 3.38 6 4.96v14.08c0 1.58 1.87 2.5 3.25 1.61l10.85-7.04a1.9 1.9 0 0 0 0-3.22L9.25 3.35Z");

        case IconType::Soundboard:
            // Discord module 7807 (SoundboardIcon), web.b19183c9af96925c.js offsets 10304236, 10304457, 10304905
            return parseSvgPath("M14.24 1.03a1 1 0 0 1 .73 1.21l-1 4a1 1 0 1 1-1.94-.48l1-4a1 1 0 0 1 1.21-.73ZM20.7 4.7a1 1 0 0 0-1.4-1.4l-4 4a1 1 0 0 0 1.4 1.4l4-4Z "
                                "M15.14 20.14c1.78-1.78.7-5.75-2.42-8.86-3.11-3.12-7.08-4.2-8.86-2.42A3.13 3.13 0 0 0 3 11V11l-1.16 8.92a2 2 0 0 0 2.24 2.24L13 21c.86-.04 1.6-.32 2.14-.86Zm-1.3-3.4a9.61 9.61 0 0 0-2.53-4.05 9.61 9.61 0 0 0-4.05-2.53c-1.27-.35-1.82-.05-1.99.11-.16.17-.46.72-.11 2a9.61 9.61 0 0 0 2.53 4.04 9.61 9.61 0 0 0 4.05 2.53c1.27.35 1.82.05 1.99-.11.16-.17.46-.72.11-2Z "
                                "M7.05 3.32a1 1 0 0 1 1.9-.64l1 3a1 1 0 0 1-1.9.64l-1-3ZM22.97 9.76a1 1 0 0 0-1.21-.73l-4 1a1 1 0 1 0 .48 1.94l4-1a1 1 0 0 0 .73-1.21ZM20.68 16.95a1 1 0 0 0 .64-1.9l-3-1a1 1 0 0 0-.64 1.9l3 1Z");
    }
    return QPainterPath();
}

void DiscordIcons::paint(QPainter* painter, IconType type, const QRectF& rect, const QColor& color) {
    if (!painter || rect.isEmpty()) return;

    painter->save();
    painter->setRenderHint(QPainter::Antialiasing, true);

    const QPainterPath iconPath = path(type);

    // Scale from native Discord 24x24 viewBox to target rect
    const qreal scale = std::min(rect.width() / 24.0, rect.height() / 24.0);
    const qreal offsetX = rect.left() + (rect.width() - 24.0 * scale) / 2.0;
    const qreal offsetY = rect.top() + (rect.height() - 24.0 * scale) / 2.0;

    painter->translate(offsetX, offsetY);
    painter->scale(scale, scale);

    painter->setPen(Qt::NoPen);
    painter->setBrush(color);
    painter->drawPath(iconPath);

    painter->restore();
}

QPixmap DiscordIcons::pixmap(IconType type, const QColor& color, int size, int devicePixelRatio) {
    const int effectiveSize = size * devicePixelRatio;
    QPixmap px(effectiveSize, effectiveSize);
    px.fill(Qt::transparent);

    {
        QPainter p(&px);
        p.setRenderHint(QPainter::Antialiasing, true);
        paint(&p, type, QRectF(0, 0, effectiveSize, effectiveSize), color);
    }
    px.setDevicePixelRatio(devicePixelRatio);
    return px;
}

QIcon DiscordIcons::icon(IconType type, const QColor& color, int size) {
    QIcon ic;
    ic.addPixmap(pixmap(type, color, size, 1));
    ic.addPixmap(pixmap(type, color, size, 2));
    return ic;
}

QIcon DiscordIcons::toggleIcon(IconType normalType, const QColor& normalColor,
                              IconType checkedType, const QColor& checkedColor,
                              int size) {
    QIcon ic;
    // Normal / Unchecked states
    ic.addPixmap(pixmap(normalType, normalColor, size, 1), QIcon::Normal, QIcon::Off);
    ic.addPixmap(pixmap(normalType, normalColor, size, 2), QIcon::Normal, QIcon::Off);
    // Checked / Active states
    ic.addPixmap(pixmap(checkedType, checkedColor, size, 1), QIcon::Normal, QIcon::On);
    ic.addPixmap(pixmap(checkedType, checkedColor, size, 2), QIcon::Normal, QIcon::On);
    return ic;
}

} // namespace triscord
