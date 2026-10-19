#include "call_views.h"

#include <QLabel>
#include <algorithm>
#include <cmath>
#include <QPainter>
#include <QPushButton>
#include <QVBoxLayout>

namespace triscord {

VoicePrejoinView::VoicePrejoinView(QWidget* parent) : QWidget(parent) {
    setObjectName("voicePrejoinView");
    setAttribute(Qt::WA_StyledBackground);
    auto* layout = new QVBoxLayout(this);
    layout->setContentsMargins(16, 0, 16, 0);
    layout->setSpacing(0);
    layout->addStretch(1);
    title_ = new QLabel(this);
    title_->setObjectName("voicePrejoinTitle");
    title_->setAlignment(Qt::AlignHCenter);
    subtitle_ = new QLabel(this);
    subtitle_->setObjectName("voicePrejoinSubtitle");
    subtitle_->setAlignment(Qt::AlignHCenter);
    join_ = new QPushButton("Entrar na chamada de voz", this);
    join_->setObjectName("voicePrejoinJoinButton");
    join_->setFixedHeight(40);
    join_->setCursor(Qt::PointingHandCursor);
    connect(join_, &QPushButton::clicked, this, &VoicePrejoinView::joinRequested);
    layout->addWidget(title_);
    // Observed baselines: title -> subtitle 31px, subtitle -> button top 29px.
    layout->addSpacing(8);
    layout->addWidget(subtitle_);
    layout->addSpacing(24);
    layout->addWidget(join_, 0, Qt::AlignHCenter);
    // The block sits slightly below the vertical centre (title top at y=413 of 33..891 observed).
    layout->addStretch(1);
    layout->addSpacing(22);
}

void CenterSurface::paintEvent(QPaintEvent*) {
    QPainter p(this);
    if (mode_ == Mode::Chat) { p.fillRect(rect(), QColor("#000000")); return; }
    if (mode_ == Mode::Call) { p.fillRect(rect(), Qt::black); return; }
    if (gradient_.size() != size()) gradient_ = renderGradient(size());
    p.drawImage(0, 0, gradient_);
}

// Pre-join background fitted by least squares to 11k pixels sampled on the real Discord view (1264x892 client):
// a vertical base ramp, a bright core (R+33 G+42 B+25, sigma 296x258 px) and a broad blue component (R+16 G+20
// B+85, sigma 404 px horizontally, flat up to 286px above the bottom edge and then fading), both centred at the
// bottom edge (96% of the sampled pixels within 8 levels, 85% within 4), plus a 13x10 bilinear residual table
// measured on the same samples (100% within 8, 99.5% within 4; the same figures on a held-out half of the samples).
QImage CenterSurface::renderGradient(const QSize& size) {
    QImage image(size, QImage::Format_RGB32);
    if (size.isEmpty()) return image;
    struct Stop { double at; int r, g, b; };
    static const Stop stops[] = {{0.00, 11, 9, 0}, {0.19, 16, 14, 39}, {0.42, 25, 24, 59}, {0.66, 33, 33, 86}, {0.90, 36, 38, 112}, {1.00, 42, 44, 117}};
    // Residual of the analytic model measured on the same pixels (13x10 nodes across the surface, bilinear).
    static const float residual[10][13][3] = {
        {{0.45,1.76,1.99}, {0.43,1.47,2.93}, {0.29,1,3.43}, {-0.06,0.46,2.12}, {-0.52,-0.29,0.39}, {-0.82,-0.83,-0.96}, {-0.97,-1.05,-1.63}, {-0.96,-0.99,-1.51}, {-0.92,-0.71,-0.78}, {-0.71,-0.2,0.23}, {-0.41,0.38,1.18}, {-0.21,0.89,1.65}, {-0.21,0.99,0.11}},
        {{0.39,1.51,-1.07}, {0.43,1.34,-0.1}, {0.29,0.94,0.74}, {-0.01,0.34,0.63}, {-0.4,-0.34,0.1}, {-0.73,-0.88,-0.64}, {-0.96,-1.11,-1.16}, {-0.98,-1.06,-1.05}, {-0.83,-0.74,-0.66}, {-0.57,-0.25,-0.53}, {-0.37,0.24,-1.2}, {-0.37,0.53,-2.77}, {-0.51,0.57,-4.49}},
        {{-0.01,0.78,-1.38}, {0.18,0.83,1.15}, {0.23,0.73,3.7}, {0.04,0.17,3.7}, {-0.14,-0.28,1.7}, {-0.38,-0.55,-0.52}, {-0.57,-0.73,-1.92}, {-0.69,-0.91,-2.03}, {-0.77,-0.94,-1.13}, {-0.81,-0.82,0.31}, {-0.83,-0.58,1.03}, {-0.98,-0.44,-0.89}, {-1.19,-0.44,-3.68}},
        {{-1.38,-0.9,5.76}, {-0.98,-0.45,7.75}, {-0.42,-0.14,6.98}, {0.03,0.26,4.14}, {0.42,0.41,1.4}, {0.63,0.38,-0.61}, {0.46,0.41,-1.68}, {-0.01,0.22,-1.92}, {-0.51,-0.28,-1.47}, {-1.08,-1.1,-0.68}, {-1.85,-2.01,0.33}, {-2.63,-2.74,1.29}, {-3.06,-3.02,1.33}},
        {{-2.03,-1.18,7.8}, {-1.03,-0.5,6.67}, {0.07,0.39,3.83}, {0.58,0.71,0.9}, {0.44,0.97,-0.99}, {0.58,0.47,-2.14}, {0.6,0.32,-3.11}, {0.23,0.3,-3.17}, {-0.22,0.31,-2.12}, {-0.84,-0.33,-2.24}, {-1.74,-1.43,-2.01}, {-3.13,-3.08,-2.06}, {-4.23,-4.34,-2.28}},
        {{-1.18,-0.5,4.66}, {-0.28,0.17,2.84}, {0.19,0.65,-0.09}, {0.47,0.83,-1.53}, {0.65,1.27,-0.73}, {0.21,1.03,-0.41}, {0.04,0.71,0.06}, {0.21,0.79,1.08}, {0.21,1.07,1.34}, {-0.36,0.36,-0.57}, {-1.22,-1.14,-3.48}, {-2.45,-2.68,-4.76}, {-3.52,-3.74,-5.46}},
        {{-0.4,0.13,1.28}, {-0.07,0.41,-0.52}, {-0.05,0.33,-2.27}, {0.06,0.49,-1.19}, {-0.17,0.27,-0.98}, {-0.64,-0.1,-1.31}, {-0.71,-0.23,-0.87}, {-0.55,0,0.27}, {-0.33,0.17,1.43}, {-0.56,0.14,1.27}, {-1.05,-0.91,-1.73}, {-2.6,-2.63,-6.64}, {-3.53,-3.47,-8.2}},
        {{1.46,1.7,0.38}, {1.3,1.44,-0.7}, {1.08,1.15,0.17}, {0.37,0.37,1.04}, {-0.76,-0.8,0.06}, {-1.36,-1.37,-0.58}, {-1.32,-1.32,0.18}, {-1.15,-1.04,1.56}, {-0.79,-0.67,2.8}, {-0.21,-0.1,3.31}, {-0.07,-0.09,1.38}, {-1.15,-1.38,-4.82}, {-2.14,-2.65,-9.36}},
        {{2.47,2.46,-0.35}, {2,1.82,-0.75}, {1.31,1.03,0.73}, {0,-0.5,0.41}, {-0.13,-0.83,-1.28}, {1.48,0.91,-1.93}, {2.23,1.8,-1.62}, {1.33,0.93,0.06}, {-0.56,-0.94,1.35}, {-1.05,-1.48,1.77}, {-0.36,-0.8,0.6}, {-0.76,-1.36,-5}, {-1.76,-2.61,-10.91}},
        {{1.09,1.32,0.97}, {0.53,0.54,0.59}, {-0.31,-0.4,1.84}, {-0.76,-1.12,0.92}, {2.04,1.42,-1.02}, {6.97,6.53,-2.19}, {8.52,8.11,-3.1}, {5.67,5.34,-1.29}, {0.64,0.36,0.76}, {-2.64,-3.06,1.03}, {-2.58,-3.01,-0.07}, {-2.75,-3.26,-5.25}, {-3.7,-4.52,-11.14}}
    };
    auto correction = [&](int x, int y, int channel) {
        const double u = std::clamp(size.width() > 1 ? double(x) / (size.width() - 1) * (13 - 1) : 0.0, 0.0, 13 - 1.001);
        const double v = std::clamp(size.height() > 1 ? double(y) / (size.height() - 1) * (10 - 1) : 0.0, 0.0, 10 - 1.001);
        const int i = int(u), j = int(v); const double fu = u - i, fv = v - j;
        return residual[j][i][channel] * (1 - fu) * (1 - fv) + residual[j][i + 1][channel] * fu * (1 - fv)
             + residual[j + 1][i][channel] * (1 - fu) * fv + residual[j + 1][i + 1][channel] * fu * fv;
    };
    const double centreX = size.width() / 2.0;
    for (int y = 0; y < size.height(); ++y) {
        const double t = size.height() > 1 ? double(y) / (size.height() - 1) : 0.0;
        int i = 0;
        while (i < 4 && t > stops[i + 1].at) ++i;
        const double f = std::clamp((t - stops[i].at) / (stops[i + 1].at - stops[i].at), 0.0, 1.0);
        const double r0 = stops[i].r + (stops[i + 1].r - stops[i].r) * f, g0 = stops[i].g + (stops[i + 1].g - stops[i].g) * f,
                     b0 = stops[i].b + (stops[i + 1].b - stops[i].b) * f;
        const double dy = size.height() - 1 - y;
        // The broad component stays flat up to ~286px above the bottom edge, then fades.
        const double vertical = dy <= 286.0 ? 1.0 : std::max(0.4, 1.0 - 0.00183 * (dy - 286.0));
        auto* line = reinterpret_cast<QRgb*>(image.scanLine(y));
        for (int x = 0; x < size.width(); ++x) {
            const double dx = x - centreX;
            const double core = std::exp(-(dx * dx) / (296.0 * 296.0) - (dy * dy) / (258.0 * 258.0));
            const double broad = std::exp(-(dx * dx) / (404.0 * 404.0)) * vertical;
            line[x] = qRgb(std::clamp(int(r0 + 33.25 * core + 16.16 * broad + correction(x, y, 0) + 0.5), 0, 255),
                           std::clamp(int(g0 + 41.9 * core + 20 * broad + correction(x, y, 1) + 0.5), 0, 255),
                           std::clamp(int(b0 + 25 * core + 84.7 * broad + correction(x, y, 2) + 0.5), 0, 255));
        }
    }
    return image;
}

void VoicePrejoinView::setChannel(const QString& name, int occupants) {
    title_->setText(name);
    subtitle_->setText(occupants == 0 ? QString("Ninguém está em voz") : QString());
}

} // namespace triscord
