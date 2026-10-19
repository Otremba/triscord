#include "update_splash.h"
#include <QCryptographicHash>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QPainter>
#include <QPainterPath>
#include <QProcess>
#include <QRegularExpression>
#include <QScreen>
#include <QStandardPaths>
#include <cstdio>

namespace triscord {
namespace {
constexpr int kWidth = 300, kHeight = 350;   // splashScreen windowConfig: width 300, LOADING_WINDOW_HEIGHT 350 (Windows)
const QColor kBackground("#282b30");         // --account-grey
const QString kReleases = QStringLiteral("https://api.github.com/repos/Otremba/triscord/releases?per_page=30");
// Discord's splash animation (splash/videos/connecting.webp in app.asar, 400x400, 64 frames, 1050ms, looping): the
// logo rests, winds back to -9 degrees, spins a full turn clockwise overshooting to 369 and settles at 360. Angle of
// each frame measured against frame 0 (best match of every rotation in 3-degree steps). The logo is 144px wide in the
// 400px frame: 72px in the 200px box. Discord's frames also carry motion blur; triscord draws the plain logo.
constexpr int kFrames = 64, kLoopMs = 1050;
constexpr int kAngles[kFrames] = {0, 0, 0, 0, 0, 0, 0, 0, -3, -3, -3, -3, -6, -6, -6, -9, -9, -9, -9, -6, 3, 15, 33, 48, 69, 93,
    111, 135, 159, 183, 216, 237, 255, 273, 297, 315, 330, 345, 357, 363, 366, 369, 369, 369, 369, 369, 369, 369, 366, 366, 366,
    366, 363, 363, 363, 360, 360, 360, 360, 360, 360, 360, 360, 360};
// The logo of triscord-amoled.png as a white glyph: its light pixels, cropped to their bounds.
QImage whiteGlyph(const QImage& icon) {
    if (icon.isNull()) return {};
    const auto gray = icon.convertToFormat(QImage::Format_Grayscale8);
    QRect bounds;
    for (int y = 0; y < gray.height(); ++y) {
        const auto* row = gray.constScanLine(y);
        for (int x = 0; x < gray.width(); ++x) if (row[x] > 128) bounds |= QRect(x, y, 1, 1);
    }
    QImage glyph(bounds.size(), QImage::Format_ARGB32_Premultiplied);
    for (int y = 0; y < bounds.height(); ++y) {
        const auto* row = gray.constScanLine(bounds.top() + y);
        auto* out = reinterpret_cast<QRgb*>(glyph.scanLine(y));
        for (int x = 0; x < bounds.width(); ++x) { const int a = row[bounds.left() + x]; out[x] = qRgba(a, a, a, a); }
    }
    return glyph;
}
}

SplashWindow::SplashWindow() : glyph_(whiteGlyph(QImage(":/triscord/icon.png"))) {
    frame_.setInterval(kLoopMs / kFrames);
    QObject::connect(&frame_, &QTimer::timeout, [this] { update(); });
    clock_.start(); frame_.start();
    setFlags(Qt::Window | Qt::FramelessWindowHint);
    setTitle("Triscord");
    resize(kWidth, kHeight);
    if (auto* screen = QGuiApplication::primaryScreen()) {   // center: true
        const auto area = screen->availableGeometry();
        setPosition(area.center() - QPoint(kWidth / 2, kHeight / 2));
    }
}

void SplashWindow::setStatus(const QString& text, int progress) {
    if (text == status_ && progress == progress_) return;
    status_ = text; progress_ = progress; update();
    // Logged as Discord's "splashScreen: <state>" lines (stdout, like the other diagnostics of the app).
    std::printf("splash: %s%s\n", text.toUtf8().constData(), progress >= 0 ? QString(" %1%").arg(progress).toUtf8().constData() : "");
    std::fflush(stdout);
}

void SplashWindow::mousePressEvent(QMouseEvent*) { startSystemMove(); }

void SplashWindow::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing); p.setRenderHint(QPainter::SmoothPixmapTransform);
    p.fillRect(QRect(0, 0, width(), height()), kBackground);
    // #splash: flex centre with padding-bottom 10px; .splash-inner = 200px media + .splash-text (status line and the
    // progress row: 10px margin + 8px), the text pulled 30px up (top: -30px).
    const int line = 20, inner = 200 + line + 10 + 8;
    const int top = (kHeight - 10 - inner) / 2, mediaTop = top, textTop = top + 200 - 30;
    // Media: Discord's animation, with triscord's logo (Discord's own logo is its brand).
    if (!glyph_.isNull()) {
        const int frame = int(clock_.elapsed() % kLoopMs) * kFrames / kLoopMs;
        const QSizeF size(72, 72.0 * glyph_.height() / glyph_.width());
        p.save();
        p.translate(kWidth / 2.0, mediaTop + 100.0);
        p.rotate(kAngles[frame]);
        p.drawImage(QRectF(QPointF(-size.width() / 2, -size.height() / 2), size), glyph_);
        p.restore();
    }
    QFont font("gg sans"); font.setPixelSize(16); font.setWeight(QFont::Medium);
    font.setFeature(QFont::Tag("tnum"), 1);
    p.setFont(font); p.setPen(Qt::white);
    p.drawText(QRect(0, textTop, kWidth, line), Qt::AlignHCenter | Qt::AlignVCenter, status_);
    if (progress_ >= 0) {
        const QRectF bar((kWidth - 180) / 2.0, textTop + line + 10, 180, 8);
        p.setPen(Qt::NoPen); p.setBrush(QColor(255, 255, 255, 26));
        p.drawRoundedRect(bar, 4, 4);
        p.setBrush(QColor("#737f8d"));
        p.drawRoundedRect(QRectF(bar.topLeft(), QSizeF(bar.width() * std::clamp(progress_, 0, 100) / 100.0, bar.height())), 4, 4);
    }
}

bool versionNewer(const QString& candidate, const QString& current) {
    const auto a = candidate.split('.'), b = current.split('.');
    if (a.size() != 3 || b.size() != 3) return false;
    for (int i = 0; i < 3; ++i) {
        bool ok1 = false, ok2 = false;
        const int x = a[i].toInt(&ok1), y = b[i].toInt(&ok2);
        if (!ok1 || !ok2) return false;
        if (x != y) return x > y;
    }
    return false;
}

Updater::Updater(SplashWindow* splash, QString currentVersion, QObject* parent)
    : QObject(parent), splash_(splash), current_(std::move(currentVersion)) {
    timeout_.setSingleShot(true); timeout_.setInterval(10000);   // updateTimeout: 1e4
    connect(&timeout_, &QTimer::timeout, this, [this] { if (reply_) reply_->abort(); });
}

void Updater::start() { check(); }

void Updater::check() {
    splash_->setStatus(QStringLiteral("Checking for updates…"));
    QNetworkRequest request(QUrl(qEnvironmentVariable("TRISCORD_UPDATE_URL", kReleases)));
    request.setTransferTimeout(10000);
    request.setRawHeader("Accept", "application/vnd.github+json");
    request.setRawHeader("User-Agent", "Triscord-Updater");
    reply_ = network_.get(request);
    timeout_.start();
    connect(reply_, &QNetworkReply::finished, this, [this, reply = reply_] {
        timeout_.stop(); reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (status == 403 || status == 404 || status == 429) { splash_->setStatus(QStringLiteral("Starting…")); emit launch(); return; }
        if (reply->error() != QNetworkReply::NoError || status != 200) { failed(reply->errorString()); return; }
        const auto releases = QJsonDocument::fromJson(reply->readAll()).array();
        static const QRegularExpression tag("^desktop-v(\\d+\\.\\d+\\.\\d+)$");
        for (const auto& value : releases) {
            const auto release = value.toObject();
            if (release.value("draft").toBool() || release.value("prerelease").toBool()) continue;
            const auto match = tag.match(release.value("tag_name").toString());
            if (!match.hasMatch()) continue;
            const auto version = match.captured(1);
            if (!versionNewer(version, current_)) break;   // newest first: nothing newer than us
            QUrl installer, checksum;
            for (const auto& asset : release.value("assets").toArray()) {
                const auto name = asset.toObject().value("name").toString();
                const QUrl url(asset.toObject().value("browser_download_url").toString());
                if (name == QString("Triscord-Setup-%1.exe").arg(version)) installer = url;
                if (name == QString("Triscord-Setup-%1.exe.sha256").arg(version)) checksum = url;
            }
            if (installer.isValid() && checksum.isValid()) { download(installer, checksum, version); return; }
        }
        splash_->setStatus(QStringLiteral("Starting…"));
        emit launch();
    });
}

void Updater::failed(const QString& why) {
    std::printf("update check failed: %s\n", why.toUtf8().constData()); std::fflush(stdout);
    if (file_) { file_->remove(); delete file_; file_ = nullptr; }
    timeout_.stop();
    splash_->setStatus(QStringLiteral("Starting installed version…"));
    emit launch();
}

void Updater::download(const QUrl& installer, const QUrl& checksum, const QString& version) {
    version_ = version;
    splash_->setStatus(QStringLiteral("Downloading update 1 of 1…"), 0);
    QNetworkRequest sumRequest(checksum);
    sumRequest.setTransferTimeout(10000);
    sumRequest.setRawHeader("User-Agent", "Triscord-Updater");
    sumRequest.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
    auto* sum = network_.get(sumRequest);
    connect(sum, &QNetworkReply::finished, this, [this, sum, installer] {
        sum->deleteLater();
        expectedSha_ = QString::fromLatin1(sum->readAll()).trimmed().left(64).toLower();
        if (sum->error() != QNetworkReply::NoError || !QRegularExpression("^[0-9a-f]{64}$").match(expectedSha_).hasMatch()) {
            failed("checksum"); return;
        }
        path_ = QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation)).filePath(QString("Triscord-Setup-%1.exe").arg(version_));
        file_ = new QFile(path_);
        if (!file_->open(QIODevice::WriteOnly | QIODevice::Truncate)) { failed("temp file"); return; }
        QNetworkRequest request(installer);
        request.setTransferTimeout(10000);
        request.setRawHeader("User-Agent", "Triscord-Updater");
        request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
        reply_ = network_.get(request);
        connect(reply_, &QNetworkReply::readyRead, this, [this, reply = reply_] { if (file_) file_->write(reply->readAll()); });
        connect(reply_, &QNetworkReply::downloadProgress, this, [this](qint64 received, qint64 total) {
            if (total > 0) splash_->setStatus(QStringLiteral("Downloading update 1 of 1…"), int(received * 100 / total));
        });
        connect(reply_, &QNetworkReply::finished, this, [this, reply = reply_] {
            reply->deleteLater();
            if (reply->error() != QNetworkReply::NoError) { failed(reply->errorString()); return; }
            if (file_) file_->write(reply->readAll());
            verifyAndInstall();
        });
    });
}

void Updater::verifyAndInstall() {
    file_->close(); delete file_; file_ = nullptr;
    splash_->setStatus(QStringLiteral("Installing update 1 of 1…"), 0);
    QFile file(path_);
    QCryptographicHash hash(QCryptographicHash::Sha256);
    if (!file.open(QIODevice::ReadOnly) || !hash.addData(&file) || QString::fromLatin1(hash.result().toHex()) != expectedSha_) {
        file.close(); QFile::remove(path_); failed("checksum mismatch"); return;
    }
    file.close();
    // The installer waits for this process to exit, replaces the installation and starts the new version.
    QStringList arguments{"/S", "/UPDATE"};
    // The portable launcher can keep opening the installed version after this update succeeds.
    const auto portable = qEnvironmentVariable("TRISCORD_PORTABLE_RUNTIME");
    if (!portable.isEmpty() && QDir(portable) == QDir(QCoreApplication::applicationDirPath())
        && QFile::exists(QDir(portable).filePath("complete.marker")))
        arguments << "/PORTABLE"; // the Unicode runtime path is inherited through the environment
    if (!QProcess::startDetached(path_, arguments)) { failed("installer"); return; }
    splash_->setStatus(QStringLiteral("Installing update 1 of 1…"), 100);
    emit installing();
}
}
