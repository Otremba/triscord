#include <QDesktopServices>
#include "main_window.h"
#include "server_dialog.h"
#include "profile_media.h"
#include "ice_config.h"
#include "share_session.h"
#include "participant_pane.h"
#include "camera_view.h"
#include "private_settings.h"
#include "chat_pane.h"
#include "soundboard.h"
#include "call_shortcuts.h"
#include "desktop_notifications.h"
#include "discord_icons.h"
#include "account_panel.h"
#include "discord_tooltip.h"
#include "native_frame.h"
#include "navigation_chrome.h"
#include "call_views.h"
#include "settings_view.h"
#include "google_auth.h"
#include "nick_dialog.h"
#include "profile_edit_dialog.h"
#include <QScrollBar>
#include <QStandardPaths>
#include <QDir>
#include <QFileInfo>
#include "channel_composer.h"
#include "voice_mix.h"
#include <QApplication>
#include "group_connection.h"
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QSettings>
#include <QSignalBlocker>
#include <QSplitter>
#include <QUuid>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QFormLayout>
#include <QComboBox>
#include <QCheckBox>
#include <QInputDialog>
#include <QMenu>
#include <QSlider>
#include <QSpinBox>
#include <QWidgetAction>
#include <QCheckBox>
#include <QClipboard>
#include <QGuiApplication>
#include <QDialog>
#include <QPainter>
#include <QTimer>
#include <QScrollArea>
#include <QStackedWidget>
#include <QGridLayout>

namespace triscord {
namespace {
// Keeps the call bar floating over the bottom of the call area: Discord's bar sits 17px above the window edge
// while the cards stop 49px above it, so it cannot live in the stage layout.
class DockPlacer final : public QObject {
public:
    DockPlacer(QWidget* body, QWidget* dock) : QObject(body), body_(body), dock_(dock) { body->installEventFilter(this); place(); }
    bool eventFilter(QObject*, QEvent* event) override {
        if (event->type() == QEvent::Resize || event->type() == QEvent::Show) place();
        return false;
    }
private:
    void place() { dock_->setGeometry(0, body_->height() - 66, body_->width(), 66); dock_->raise(); }
    QWidget* body_; QWidget* dock_;
};
} // namespace

MainWindow::MainWindow(QWidget* parent, VoiceCall::AudioMode audioMode) : QMainWindow(parent), signaling_(this), voice_(&signaling_, this, audioMode), screen_(&signaling_, this), camera_(&signaling_, this) {
    setWindowTitle("Triscord");
    resize(1180, 760); setMinimumSize(860, 560);
    QSettings settings;
    userId_ = settings.value("userId").toString();
    if (userId_.isEmpty()) {
        userId_ = "native_" + QUuid::createUuid().toString(QUuid::WithoutBraces);
        settings.setValue("userId", userId_);
    }
    auto* root = new QWidget(this);
    auto* layout = new QVBoxLayout(root);
    layout->setContentsMargins(0, 0, 0, 0); layout->setSpacing(0);
    serverUrl_ = groupConnection::automatic ? QString::fromUtf8(groupConnection::server)
        : settings.value("serverUrl", groupConnection::server).toString();
    // End-to-end tests run the real Workers locally (tests/e2e/); this points the client at that hub.
    if (const auto hub = qEnvironmentVariable("TRISCORD_HUB_SERVER"); !hub.isEmpty()) serverUrl_ = hub;
    groupInvite_ = groupConnection::automatic ? QString::fromUtf8(groupConnection::invite)
        : unprotectSetting(settings.value("inviteProtected").toByteArray());
    username_ = settings.value("username").toString().trimmed().left(32);
    connect(&authSession_, &AuthSession::signedIn, this, [this] {
        if (!authSession_.nick().isEmpty()) {
            username_ = authSession_.nick();
            QSettings().setValue("username", username_);
        }
        updateUserProfile();
        hub_.setSession(authSession_.session());
        refreshIce();
        refreshServers(QSettings().value("lastServerId").toString());
    });
    connect(&RemoteImageCache::instance(), &RemoteImageCache::loaded, this, [this](const QString& url) {
        if (url == authSession_.avatarUrl()) updateUserProfile();
    });
    connect(&authSession_, &AuthSession::signedOut, this, [this] {
        hub_.setSession({});
        clearSessionIceServers();
        iceRefresh_.stop();
        updateUserProfile();
    });
    hub_.setBaseUrl(serverUrl_);
    hub_.setSession(authSession_.session());
    // GET /ice credentials live 600 s and a cached set may already be 300 s old: refresh every 240 s
    // so a peer created late in a call never receives an expired relay (cloudflare/src/worker.js).
    iceRefresh_.setInterval(240000);
    connect(&iceRefresh_, &QTimer::timeout, this, &MainWindow::refreshIce);
    authSession_.validateAsync();
    status_ = new QLabel(root);
    status_->hide();
    noticeTimer_.setSingleShot(true);
    connect(&noticeTimer_, &QTimer::timeout, status_, &QWidget::hide);
    status_->setWordWrap(true); status_->setObjectName("connectionStatus");
    status_->setContentsMargins(18,4,18,4);
    soundboard_ = new Soundboard(this);
    connect(soundboard_, &Soundboard::message, this, &MainWindow::showNotice);
    connect(soundboard_, &Soundboard::playRequested, this, [this](const QString& id) {
        if (!roomId_.isEmpty()) signaling_.sendEvent("soundboard-play", {{"soundId", id}});
    });
    shortcuts_ = new CallShortcuts(this, audioMode == VoiceCall::AudioMode::Devices);
    notifications_ = new DesktopNotifications(this, audioMode == VoiceCall::AudioMode::Devices);
    notifications_->setEnabled(settings.value("desktopNotifications", true).toBool());
    connect(notifications_, &DesktopNotifications::openRequested, this, [this] { showNormal(); raise(); activateWindow(); });
    connect(shortcuts_, &CallShortcuts::message, this, &MainWindow::showNotice);
    connect(shortcuts_, &CallShortcuts::muteRequested, this, [this] { if (mute_ && mute_->isEnabled()) mute_->toggle(); });
    connect(shortcuts_, &CallShortcuts::talkingChanged, this, [this](bool held) { talkHeld_ = held; applyMicrophoneState(); });

    // User settings modal observed in Discord (desktop/out/claude-observations/SETTINGS.md): drawn inside
    // the window over a darkened backdrop, 40px from the edges; 252px nav with the profile, categories and
    // section anchors; content with a 48px header (title + close) and a ~700px centred column. Only
    // options with a triscord function are shown.
    auto* settingsDialog = new QDialog(this); settingsDialog->setWindowTitle("Configurações");
    settingsDialog->setWindowFlags(Qt::Widget); // QDialog forces Qt::Dialog when constructed with no window type
    settingsDialog->setObjectName("audioSettingsDialog");
    settingsDialog->setAttribute(Qt::WA_StyledBackground);
    settingsDialog->hide();
    struct CoverParent : QObject {
        QWidget* dialog;
        bool eventFilter(QObject* watched, QEvent* event) override {
            if (event->type() == QEvent::Resize) dialog->setGeometry(static_cast<QWidget*>(watched)->rect());
            return false;
        }
    };
    auto* cover = new CoverParent; cover->setParent(settingsDialog); cover->dialog = settingsDialog; installEventFilter(cover);
    connect(settingsDialog, &QDialog::finished, settingsDialog, [settingsDialog] { settingsDialog->hide(); });
    auto* settingsOuter = new QVBoxLayout(settingsDialog); settingsOuter->setContentsMargins(40, 40, 40, 40);
    auto* settingsPanel = new QWidget(settingsDialog); settingsPanel->setObjectName("settingsPanel");
    settingsPanel->setAttribute(Qt::WA_StyledBackground);
    settingsOuter->addWidget(settingsPanel);
    auto* mainSettingsLayout = new QHBoxLayout(settingsPanel);
    mainSettingsLayout->setContentsMargins(1, 1, 1, 1); mainSettingsLayout->setSpacing(0);

    auto* settingsSidebar = new QWidget(settingsPanel); settingsSidebar->setObjectName("settingsSidebar");
    settingsSidebar->setAttribute(Qt::WA_StyledBackground);
    settingsSidebar->setFixedWidth(252);
    auto* settingsSidebarLayout = new QVBoxLayout(settingsSidebar);
    settingsSidebarLayout->setContentsMargins(16, 24, 16, 16); settingsSidebarLayout->setSpacing(16);
    // Profile header: 48px avatar, name and "Editar perfil" (the existing name editor). Search has no
    // triscord function and is not drawn.
    auto* profileHeader = new QWidget(settingsSidebar); profileHeader->setObjectName("settingsProfileHeader");
    auto* profileLayout = new QHBoxLayout(profileHeader); profileLayout->setContentsMargins(8, 0, 0, 0); profileLayout->setSpacing(12);
    auto* profileAvatar = new QLabel(profileHeader); profileAvatar->setObjectName("settingsProfileAvatar"); profileAvatar->setFixedSize(48, 48);
    auto* profileText = new QVBoxLayout; profileText->setSpacing(2);
    auto* profileName = new ElidedLabel(username_.isEmpty() ? "Usuário" : username_, profileHeader); profileName->setObjectName("settingsProfileName");
    auto* editProfile = new QPushButton("Editar perfil", profileHeader); editProfile->setObjectName("settingsEditProfile");
    editProfile->setIcon(DiscordIcons::icon(DiscordIcons::IconType::Pencil, QColor("#96979e"), 14));
    editProfile->setLayoutDirection(Qt::RightToLeft); editProfile->setCursor(Qt::PointingHandCursor);
    editProfile->setSizePolicy(QSizePolicy::Fixed, QSizePolicy::Fixed);
    profileText->addStretch(1); profileText->addWidget(profileName); profileText->addWidget(editProfile, 0, Qt::AlignLeft | Qt::AlignAbsolute); profileText->addStretch(1);
    profileLayout->addWidget(profileAvatar); profileLayout->addLayout(profileText, 1);
    settingsSidebarLayout->addWidget(profileHeader);
    connect(editProfile, &QPushButton::clicked, this, [this, profileName] {
        openEditProfileDialog();
        profileName->setText(username_);
    });

    auto* settingsNav = new QListWidget(settingsSidebar); settingsNav->setObjectName("settingsNav");
    settingsNav->setItemDelegate(new SettingsNavDelegate(settingsNav));
    settingsNav->setMouseTracking(true); settingsNav->viewport()->setAttribute(Qt::WA_Hover);
    settingsNav->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    auto addNav = [settingsNav](const QString& text, int kind, DiscordIcons::IconType icon) {
        auto* item = new QListWidgetItem(text, settingsNav);
        item->setData(SettingsNavDelegate::KindRole, kind);
        item->setData(SettingsNavDelegate::IconRole, static_cast<int>(icon));
        if (kind == SettingsNavDelegate::Section) item->setFlags(Qt::NoItemFlags);
        return item;
    };
    // Observed order: "Notificações" among the account categories, then "Experiência" > "Voz e vídeo"
    // with its section anchors.
    auto* notifNav = addNav("Notificações", SettingsNavDelegate::Category, DiscordIcons::IconType::Bell);
    addNav("Experiência", SettingsNavDelegate::Section, DiscordIcons::IconType::Bell);
    auto* voiceNav = addNav("Voz e vídeo", SettingsNavDelegate::Category, DiscordIcons::IconType::Microphone);
    auto* voiceSubNav = addNav("Voz", SettingsNavDelegate::Sub, DiscordIcons::IconType::Microphone);
    auto* videoSubNav = addNav("Vídeo", SettingsNavDelegate::Sub, DiscordIcons::IconType::Microphone);
    auto* soundsSubNav = addNav("Painel de efeitos sonoros", SettingsNavDelegate::Sub, DiscordIcons::IconType::Microphone);
    settingsSidebarLayout->addWidget(settingsNav, 1);
    mainSettingsLayout->addWidget(settingsSidebar);

    auto* contentArea = new QWidget(settingsPanel); contentArea->setObjectName("settingsContentArea");
    contentArea->setAttribute(Qt::WA_StyledBackground);
    auto* contentLayout = new QVBoxLayout(contentArea);
    contentLayout->setContentsMargins(0, 0, 0, 0); contentLayout->setSpacing(0);
    auto* contentHeader = new QWidget(contentArea); contentHeader->setObjectName("settingsContentHeader");
    contentHeader->setAttribute(Qt::WA_StyledBackground); contentHeader->setFixedHeight(49);
    auto* topHeader = new QHBoxLayout(contentHeader); topHeader->setContentsMargins(17, 0, 12, 1);
    auto* contentTitle = new QLabel("Voz e vídeo", contentHeader); contentTitle->setObjectName("settingsContentTitle");
    auto* settingsClose = new QPushButton(contentHeader); settingsClose->setObjectName("btnSettingsDone");
    settingsClose->setFixedSize(32, 32); settingsClose->setIconSize(QSize(24, 24));
    setHoverIcons(settingsClose, DiscordIcons::icon(DiscordIcons::IconType::Close, QColor("#96979e"), 24),
                  DiscordIcons::icon(DiscordIcons::IconType::Close, QColor("#dcdcdf"), 24));
    connect(settingsClose, &QPushButton::clicked, settingsDialog, &QDialog::accept);
    topHeader->addWidget(contentTitle, 1); topHeader->addWidget(settingsClose);
    contentLayout->addWidget(contentHeader);

    auto* stackedPages = new QStackedWidget(contentArea);
    auto makePage = [stackedPages](QScrollArea*& scroll) {
        scroll = new QScrollArea(stackedPages); scroll->setWidgetResizable(true); scroll->setFrameShape(QFrame::NoFrame);
        auto* holder = new QWidget(scroll); holder->setObjectName("settingsPageHolder");
        auto* center = new QHBoxLayout(holder); center->setContentsMargins(46, 63, 24, 56); // observed: column 690px wide, 120px from the content edge, 16px scrollbar gutter
        auto* column = new QWidget(holder); column->setMaximumWidth(700);
        auto* columnLayout = new QVBoxLayout(column); columnLayout->setContentsMargins(0, 0, 0, 0); columnLayout->setSpacing(24);
        center->addStretch(1); center->addWidget(column, 100); center->addStretch(1);
        scroll->setWidget(holder);
        stackedPages->addWidget(scroll);
        return std::pair{column, columnLayout};
    };

    // Page: Voz e vídeo
    QScrollArea* voiceScroll = nullptr;
    auto [voicePage, voiceLayout] = makePage(voiceScroll);
    auto* voiceHeading = settingsHeading(voicePage, "Voz");
    voiceLayout->addWidget(voiceHeading);
    inputPreference_ = settings.value("audioInput").toString();
    outputPreference_ = settings.value("audioOutput").toString();
    auto* deviceGrid = new QGridLayout; deviceGrid->setHorizontalSpacing(14); deviceGrid->setVerticalSpacing(8); // observed gap between the combos is 17px visible (they paint 2px inside their rect)
    auto fieldLabel = [voicePage](const QString& text) { auto* l = new QLabel(text, voicePage); l->setObjectName("settingsRowLabel"); return l; };
    inputDevice_ = new QComboBox(voicePage); inputDevice_->addItem("Padrão do Windows", QString{});
    outputDevice_ = new QComboBox(voicePage); outputDevice_->addItem("Padrão do Windows", QString{});
    inputDevice_->setObjectName("settingsInputDevice"); outputDevice_->setObjectName("settingsOutputDevice");
    inputDevice_->setItemIcon(0, DiscordIcons::icon(DiscordIcons::IconType::Microphone, QColor("#96979e"), 20));
    outputDevice_->setItemIcon(0, DiscordIcons::icon(DiscordIcons::IconType::Headphones, QColor("#96979e"), 20));
    for (auto* device : {inputDevice_, outputDevice_}) {
        device->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
        device->setMinimumContentsLength(10); device->setFixedHeight(40); device->setIconSize(QSize(20, 20));
    }
    deviceGrid->addWidget(fieldLabel("Microfone"), 0, 0); deviceGrid->addWidget(inputDevice_, 1, 0);
    deviceGrid->addWidget(fieldLabel("Alto-falante"), 0, 1); deviceGrid->addWidget(outputDevice_, 1, 1);

    auto* inVolSlider = new QSlider(Qt::Horizontal, voicePage); inVolSlider->setObjectName("inputVolumeSlider"); inVolSlider->setRange(0, 100);
    inVolSlider->setValue(settings.value("audioInputVolume", 100).toInt());
    voice_.setInputGain(sliderToGain(inVolSlider->value()));
    connect(inVolSlider, &QSlider::valueChanged, this, [this](int val) {
        QSettings().setValue("audioInputVolume", val);
        voice_.setInputGain(sliderToGain(val));
    });
    auto* outVolSlider = new QSlider(Qt::Horizontal, voicePage); outVolSlider->setObjectName("outputVolumeSlider"); outVolSlider->setRange(0, 200);
    outVolSlider->setValue(settings.value("audioOutputVolume", 100).toInt());
    voice_.setOutputGain(sliderToGain(outVolSlider->value()));
    connect(outVolSlider, &QSlider::valueChanged, this, [this](int val) {
        QSettings().setValue("audioOutputVolume", val);
        voice_.setOutputGain(sliderToGain(val));
    });
    deviceGrid->addItem(new QSpacerItem(0, 15), 2, 0);
    for (auto* volume : {inVolSlider, outVolSlider}) volume->setFixedHeight(24); // observed: 16px handle centred 25px below the label
    deviceGrid->addWidget(fieldLabel("Volume do Microfone"), 3, 0); deviceGrid->addWidget(inVolSlider, 4, 0);
    deviceGrid->addWidget(fieldLabel("Volume do Alto-falante"), 3, 1); deviceGrid->addWidget(outVolSlider, 4, 1);
    deviceGrid->setColumnStretch(0, 1); deviceGrid->setColumnStretch(1, 1);
    voiceLayout->addLayout(deviceGrid);
    voiceLayout->addWidget(settingsDivider(voicePage));

    // "Supressão de ruído" is a dropdown (Krisp) in Discord; triscord's filter is on/off.
    auto* noise = new SettingsToggle(voicePage); noise->setObjectName("noiseSuppression");
    noise->setChecked(settings.value("noiseSuppression", true).toBool());
    settings.remove("echoReduction");
    voiceLayout->addWidget(settingsRow(voicePage, "Supressão de ruído", "Reduz o ruído de fundo do seu microfone.", noise));

    auto* ptt = new SettingsToggle(voicePage); ptt->setObjectName("pushToTalk");
    ptt->setChecked(settings.value("pushToTalk", false).toBool());
    voiceLayout->addWidget(settingsRow(voicePage, "Apertar para Falar", QString(), ptt));
    auto* talkKey = new QComboBox(voicePage); talkKey->setObjectName("talkKey"); talkKey->setFixedHeight(40);
    for (int n = 6; n <= 11; ++n) talkKey->addItem(QString("F%1").arg(n), 0x70 + n - 1);
    int keyIndex = talkKey->findData(settings.value("talkKey", 0x77).toInt()); talkKey->setCurrentIndex(keyIndex < 0 ? 2 : keyIndex);
    auto* releaseDelay = new QSpinBox(voicePage); releaseDelay->setObjectName("pttReleaseDelay"); releaseDelay->setFixedHeight(40);
    releaseDelay->setRange(0, 2000); releaseDelay->setSingleStep(10); releaseDelay->setSuffix(" ms");
    releaseDelay->setValue(settings.value("pttReleaseDelay", 0).toInt());
    releaseDelay->setToolTip("Tempo para fechar o microfone depois de soltar a tecla");
    // Where Discord places the key and release delay was not observed (Apertar para Falar was off).
    voiceLayout->addWidget(settingsRow(voicePage, "Tecla de Apertar para Falar", QString(), talkKey));
    voiceLayout->addWidget(settingsRow(voicePage, "Atraso para soltar", "Tempo para fechar o microfone depois de soltar a tecla.", releaseDelay));
    auto* globalMute = new SettingsToggle(voicePage); globalMute->setObjectName("globalMuteShortcut");
    globalMute->setChecked(settings.value("globalMuteShortcut", true).toBool());
    voiceLayout->addWidget(settingsRow(voicePage, "Atalho do microfone: Ctrl + Shift + M",
        "Alterna entre silenciar e ativar o microfone a partir de qualquer janela.", globalMute));
    voiceLayout->addWidget(settingsDivider(voicePage));

    // Video: not observable in Discord here (camera is blocked in this region); triscord's camera choice.
    auto* videoHeading = settingsHeading(voicePage, "Vídeo");
    voiceLayout->addWidget(videoHeading);
    auto* cameraDevice = new QComboBox(voicePage); cameraDevice->setObjectName("cameraDevice"); cameraDevice->setFixedHeight(40);
    cameraDevice->addItem("Padrão do Windows", QByteArray{});
    voiceLayout->addWidget(fieldLabel("Câmera"));
    voiceLayout->addWidget(cameraDevice);
    connect(&camera_, &CameraPublisher::devicesReady, this, [cameraDevice](const QList<QCameraDevice>& devices) {
        QSignalBlocker blocker(cameraDevice); cameraDevice->clear(); cameraDevice->addItem("Padrão do Windows", QByteArray{});
        for (const auto& device : devices) cameraDevice->addItem(device.description(), device.id());
        const auto preferred = QSettings().value("cameraDevice").toByteArray();
        int index = cameraDevice->findData(preferred);
        if (index < 0) { cameraDevice->addItem("Dispositivo Indisponível", preferred); index = cameraDevice->count() - 1; }
        cameraDevice->setCurrentIndex(index);
    });
    connect(cameraDevice, &QComboBox::currentIndexChanged, this, [this, cameraDevice] {
        const auto id = cameraDevice->currentData().toByteArray(); QSettings().setValue("cameraDevice", id);
        auto* button = findChild<QPushButton*>("cameraButton"); if (button && button->isChecked()) camera_.start(id);
    });
    voiceLayout->addWidget(settingsDivider(voicePage));

    // "Painel de efeitos sonoros": observed "Volume dos efeitos sonoros" maps to the soundboard volume.
    auto* soundsHeading = settingsHeading(voicePage, "Painel de efeitos sonoros");
    voiceLayout->addWidget(soundsHeading);
    auto* soundboardVolume = new QSlider(Qt::Horizontal, voicePage); soundboardVolume->setObjectName("settingsSoundboardVolume");
    soundboardVolume->setRange(0, 100); soundboardVolume->setValue(std::clamp(settings.value("soundboardVolume", 70).toInt(), 0, 100));
    voiceLayout->addWidget(settingsRow(voicePage, "Volume dos efeitos sonoros", "Controle o volume dos sons para você individualmente.", nullptr));
    voiceLayout->addWidget(soundboardVolume);
    voiceLayout->addStretch(1);

    // Section anchors: clicking scrolls to the heading; the active anchor follows the scroll position.
    const QList<std::pair<QListWidgetItem*, QWidget*>> anchors{{voiceSubNav, voiceHeading}, {videoSubNav, videoHeading}, {soundsSubNav, soundsHeading}};
    auto updateAnchors = [anchors, voiceScroll] {
        const int y = voiceScroll->verticalScrollBar()->value();
        QListWidgetItem* active = anchors.first().first;
        for (const auto& [item, heading] : anchors)
            if (heading->mapTo(voiceScroll->widget(), QPoint()).y() - 80 <= y) active = item;
        if (voiceScroll->verticalScrollBar()->value() >= voiceScroll->verticalScrollBar()->maximum() && voiceScroll->verticalScrollBar()->maximum() > 0)
            active = anchors.last().first;
        for (const auto& [item, heading] : anchors) item->setData(SettingsNavDelegate::ActiveRole, item == active);
    };
    connect(voiceScroll->verticalScrollBar(), &QScrollBar::valueChanged, settingsNav, updateAnchors);
    connect(voiceScroll->verticalScrollBar(), &QScrollBar::rangeChanged, settingsNav, updateAnchors);
    updateAnchors();

    // Page: Notificações
    QScrollArea* notifScroll = nullptr;
    auto [notifPage, notifLayout] = makePage(notifScroll);
    notifLayout->addWidget(settingsHeading(notifPage, "Notificações"));
    auto* desktopNotifications = new SettingsToggle(notifPage);
    desktopNotifications->setObjectName("desktopNotifications"); desktopNotifications->setChecked(settings.value("desktopNotifications", true).toBool());
    notifLayout->addWidget(settingsRow(notifPage, "Ativar notificações do Windows",
        "Exibe avisos nativos do sistema quando novas mensagens de chat ou eventos de chamada forem recebidos.", desktopNotifications));
    notifLayout->addStretch(1);

    connect(settingsNav, &QListWidget::itemClicked, this, [=](QListWidgetItem* item) {
        if (item == notifNav) { stackedPages->setCurrentWidget(notifScroll); contentTitle->setText("Notificações"); return; }
        stackedPages->setCurrentWidget(voiceScroll); contentTitle->setText("Voz e vídeo");
        settingsNav->setCurrentItem(voiceNav);
        for (const auto& [anchor, heading] : anchors)
            if (anchor == item) voiceScroll->verticalScrollBar()->setValue(heading->mapTo(voiceScroll->widget(), QPoint()).y() - 56);
    });
    settingsNav->setCurrentItem(voiceNav);
    stackedPages->setCurrentWidget(voiceScroll);
    contentLayout->addWidget(stackedPages, 1);
    mainSettingsLayout->addWidget(contentArea, 1);
    settingsProfileAvatar_ = profileAvatar;
    connect(soundboardVolume, &QSlider::valueChanged, this, [this](int value) {
        QSettings().setValue("soundboardVolume", value);
        if (soundboard_) soundboard_->setVolume(value);
    });

    auto configureShortcuts = [this, ptt, talkKey, globalMute, releaseDelay] {
        pushToTalk_ = ptt->isChecked(); talkHeld_ = false; talkKey->setEnabled(pushToTalk_);
        releaseDelay->setEnabled(pushToTalk_);
        QSettings settings; settings.setValue("pushToTalk", pushToTalk_); settings.setValue("talkKey", talkKey->currentData());
        settings.setValue("globalMuteShortcut", globalMute->isChecked());
        settings.setValue("pttReleaseDelay", releaseDelay->value());
        shortcuts_->configure(pushToTalk_, globalMute->isChecked(), talkKey->currentData().toUInt(), releaseDelay->value()); applyMicrophoneState();
    };
    connect(ptt, &QCheckBox::toggled, this, configureShortcuts);
    connect(talkKey, &QComboBox::currentIndexChanged, this, configureShortcuts);
    connect(globalMute, &QCheckBox::toggled, this, configureShortcuts);
    connect(releaseDelay, &QSpinBox::valueChanged, this, configureShortcuts);
    configureShortcuts();

    connect(desktopNotifications, &QCheckBox::toggled, this, [this](bool enabled) {
        QSettings().setValue("desktopNotifications", enabled); notifications_->setEnabled(enabled);
    });
    auto processing = [this, noise] {
        QSettings settings;
        settings.setValue("noiseSuppression", noise->isChecked());
        voice_.setProcessing(noise->isChecked(), false);
    };
    connect(noise, &QCheckBox::toggled, this, processing);
    voice_.setProcessing(noise->isChecked(), false);
    connect(&voice_, &VoiceService::devicesChanged, this, [this](const QJsonArray& inputs, const QJsonArray& outputs) {
        auto fill = [this](QComboBox* combo, const QJsonArray& devices, const QString& preference) {
            QSignalBlocker blocker(combo);
            combo->clear();
            combo->addItem("Padrão do Windows", QString{});
            for (const auto& value : devices) {
                const auto device = value.toObject();
                combo->addItem(device.value("name").toString(), device.value("id").toString());
            }
            int index = combo->findData(preference);
            if (index < 0) { combo->addItem("Dispositivo Indisponível", preference); index = combo->count() - 1; }
            combo->setCurrentIndex(index);
            // Observed: the Discord device fields show a microphone / headphone icon before the name.
            const auto icon = DiscordIcons::icon(combo == inputDevice_ ? DiscordIcons::IconType::Microphone : DiscordIcons::IconType::Headphones, QColor("#96979e"), 20);
            for (int i = 0; i < combo->count(); ++i) combo->setItemIcon(i, icon);
        };
        fill(inputDevice_, inputs, inputPreference_);
        fill(outputDevice_, outputs, outputPreference_);
    });
    auto selectDevices = [this] {
        inputPreference_ = inputDevice_->currentData().toString();
        outputPreference_ = outputDevice_->currentData().toString();
        QSettings settings;
        settings.setValue("audioInput", inputPreference_);
        settings.setValue("audioOutput", outputPreference_);
        screen_.setAudioOutput(QByteArray::fromHex(outputPreference_.toLatin1()));
        soundboard_->setOutput(QByteArray::fromHex(outputPreference_.toLatin1()));
        voice_.setDevices(QByteArray::fromHex(inputPreference_.toLatin1()), QByteArray::fromHex(outputPreference_.toLatin1()));
    };
    connect(inputDevice_, &QComboBox::currentIndexChanged, this, selectDevices);
    connect(outputDevice_, &QComboBox::currentIndexChanged, this, selectDevices);
    connect(&voice_, &VoiceService::message, this, [this](const QString& message) {
        if (message != "Voz conectada." && !message.startsWith("Reconectando")) showNotice(message);
    });
    connect(&voice_, &VoiceService::activeChanged, this, [this](bool active) {
        voiceReady_ = active;
        shortcuts_->setActive(active && !roomId_.isEmpty());
        if (active) {
            // VoiceCall starts muted and undeafened; reapply the panel state to the new devices.
            effectiveMuted_ = !effectiveMuted_;
            applyMicrophoneState();
            if (deafen_) voice_.setDeafened(deafen_->isChecked());
        }
        refreshAudioControls();
    });
    auto* shareSession = new ShareSession(&screen_, this, this);
    connect(&screen_, &ScreenService::message, this, &MainWindow::showNotice);
    auto* callTab = new QWidget(root);
    auto* callLayout = new QVBoxLayout(callTab); callLayout->setContentsMargins(0, 0, 0, 0);
    auto* leaveRoomButton = new QPushButton("Desconectar", root); leaveRoomButton_ = leaveRoomButton; leaveRoomButton->setObjectName("leaveCallButton"); leaveRoomButton->hide();
    connect(leaveRoomButton, &QPushButton::clicked, this, &MainWindow::leaveRoom);
    // 1px handle: the black theme removes the sidebar/content luminance step Discord uses as boundary.
    auto* splitter = new QSplitter(Qt::Horizontal, callTab); splitter->setObjectName("roomColumns"); splitter->setChildrenCollapsible(false); splitter->setHandleWidth(0);
    // Left column observed in Discord: 72px server rail + channel sidebar (1px left/top border, 12px
    // top-left radius), with the account panel floating over both (desktop/out/claude-observations/NAVIGATION.md).
    auto* leftColumn = new QWidget(splitter); leftColumn->setObjectName("leftColumn");
    auto* leftLayout = new QHBoxLayout(leftColumn); leftLayout->setContentsMargins(0, 0, 0, 8); leftLayout->setSpacing(0);
    auto* serverRail = new ServerRail(leftColumn); serverRail_ = serverRail;
    auto* triscordServer = serverRail->addServer(QPixmap(":/triscord/icon.png"), "Triscord");
    triscordServer->setSelected(true);
    legacyRailItem_ = triscordServer;
    connect(triscordServer, &QAbstractButton::clicked, this, [this] { switchServer({}); });
    connect(serverRail->addServerButton(), &QAbstractButton::clicked, this, &MainWindow::openServerDialog);
    leftLayout->addWidget(serverRail);
    auto* sidebar = new QWidget(leftColumn); sidebar->setObjectName("sidebar"); sidebar->setAttribute(Qt::WA_StyledBackground); sidebar->setMinimumWidth(220);
    leftLayout->addWidget(sidebar, 1);
    // Bottom margin keeps the channel list clear of the 58px floating panel and its 8px gap.
    auto* sidebarLayout = new QVBoxLayout(sidebar); sidebarLayout->setContentsMargins(0, 1, 0, 66); sidebarLayout->setSpacing(0);

    // Observed server header: 48px + full-width 1px divider, name at 16px from the sidebar edge. The
    // chevron/server menu and the invite button have no triscord function and are not drawn.
    auto* serverHeader = new QWidget(sidebar); serverHeader->setObjectName("serverHeader");
    serverHeader->setAttribute(Qt::WA_StyledBackground); serverHeader->setFixedHeight(49);
    auto* serverHeaderLayout = new QHBoxLayout(serverHeader);
    serverHeaderLayout->setContentsMargins(15, 0, 8, 1);
    auto* serverName = new QLabel("Triscord", serverHeader); serverName->setObjectName("serverTitle"); serverTitle_ = serverName;
    // Observed "Canais de Voz" section; its PlusSmall button is Discord's "Criar canal", which maps
    // to creating a triscord room.
    auto* voiceSection = new ChannelSectionHeader("Canais de Voz", sidebar);
    auto* createRoom = voiceSection->addButton();
    createRoom->setAccessibleName("Criar canal");
    createRoom->setEnabled(false);
    connect(createRoom, &QPushButton::clicked, this, [this] {
        if (!signaling_.ready()) { showNotice("Conecte ao servidor antes de criar uma sala."); return; }
        bool accepted = false;
        const auto name = QInputDialog::getText(this, "Nova Sala", "Nome da sala", QLineEdit::Normal, {}, &accepted).trimmed().left(32);
        if (accepted && !name.isEmpty()) joinRoom("room_" + QUuid::createUuid().toString(QUuid::WithoutBraces), name);
    });
    connect(&signaling_, &Signaling::connected, createRoom, [createRoom] { createRoom->setEnabled(true); });
    connect(&signaling_, &Signaling::disconnected, createRoom, [createRoom] { createRoom->setEnabled(false); });
    serverHeaderLayout->addWidget(serverName, 1);
    // Observed invite button at the right of the server header (SIDEBAR.md, sheet-sidebar-header.png):
    // UserPlus glyph (module 283973) in --interactive-icon-default, white-ish on hover. Shown only for a
    // hub server the account owns, because only the owner may mint invites (POST /servers/:id/invites).
    inviteButton_ = new QPushButton(serverHeader); inviteButton_->setObjectName("serverInviteButton");
    inviteButton_->setFixedSize(24, 24); inviteButton_->setIconSize(QSize(18, 18));
    inviteButton_->setCursor(Qt::PointingHandCursor); inviteButton_->setToolTip("Convidar pessoas");
    inviteButton_->setAccessibleName("Convidar pessoas");
    inviteButton_->setFlat(true); inviteButton_->setStyleSheet("QPushButton { background:transparent; border:0; }");
    setHoverIcons(inviteButton_, DiscordIcons::icon(DiscordIcons::IconType::UserPlus, QColor("#96979e"), 18),
                  DiscordIcons::icon(DiscordIcons::IconType::UserPlus, QColor("#dcdcdf"), 18));
    inviteButton_->hide();
    connect(inviteButton_, &QPushButton::clicked, this, &MainWindow::createInvite);
    serverHeaderLayout->addWidget(inviteButton_);
    sidebarLayout->addWidget(serverHeader);
    sidebarLayout->addWidget(voiceSection);
    rooms_ = new QListWidget(sidebar); rooms_->setObjectName("roomList");
    rooms_->setItemDelegate(new ChannelRowDelegate(rooms_));
    ChannelRowDelegate::guardParticipantClicks(rooms_);
    rooms_->setMouseTracking(true); rooms_->viewport()->setAttribute(Qt::WA_Hover);
    rooms_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    rooms_->setSpacing(1);
    sidebarLayout->addWidget(rooms_, 1);
    auto* collapsedFill = new QWidget(sidebar); collapsedFill->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Expanding);
    collapsedFill->hide(); sidebarLayout->addWidget(collapsedFill, 1);
    connect(voiceSection, &ChannelSectionHeader::collapsedChanged, this, [this, collapsedFill](bool collapsed) {
        rooms_->setVisible(!collapsed); collapsedFill->setVisible(collapsed);
    });

    // Floating account card observed in Discord: optional 100px "Voz conectada" section above the 56px
    // user row, both inside one bordered card (desktop/out/claude-observations/CALLS.md).
    auto* accountCard = new QWidget(leftColumn); accountCard->setObjectName("userAccountPanel");
    accountCard->setAttribute(Qt::WA_StyledBackground);
    auto* cardLayout = new QVBoxLayout(accountCard); cardLayout->setContentsMargins(1, 1, 1, 1); cardLayout->setSpacing(0);
    voiceConnectionBar_ = new QWidget(accountCard); voiceConnectionBar_->setObjectName("voiceConnectionBar");
    voiceConnectionBar_->setAttribute(Qt::WA_StyledBackground); voiceConnectionBar_->setFixedHeight(101);
    auto* vcLayout = new QVBoxLayout(voiceConnectionBar_); vcLayout->setContentsMargins(11, 12, 11, 13); vcLayout->setSpacing(12);
    auto* vcTop = new QHBoxLayout; vcTop->setContentsMargins(0, 0, 0, 0); vcTop->setSpacing(8);
    auto* vcTextLayout = new QVBoxLayout; vcTextLayout->setContentsMargins(0, 0, 0, 0); vcTextLayout->setSpacing(0);
    // The connection-quality button Discord shows at the left has no triscord measurement behind it.
    auto* vcTitle = new QLabel("Voz conectada", voiceConnectionBar_); vcTitle->setObjectName("voiceConnectedTitle");
    voiceConnectionRoom_ = new ElidedLabel("Geral / Triscord", voiceConnectionBar_); voiceConnectionRoom_->setObjectName("voiceConnectedRoom");
    vcTextLayout->addWidget(vcTitle);
    vcTextLayout->addWidget(voiceConnectionRoom_);
    vcTop->addLayout(vcTextLayout, 1);
    voiceBarDisconnect_ = new QPushButton(voiceConnectionBar_);
    voiceBarDisconnect_->setObjectName("voiceBarDisconnect");
    voiceBarDisconnect_->setFixedSize(32, 32);
    voiceBarDisconnect_->setIconSize(QSize(20, 20));
    setHoverIcons(voiceBarDisconnect_, DiscordIcons::icon(DiscordIcons::IconType::Disconnect, QColor("#96979e"), 20),
                  DiscordIcons::icon(DiscordIcons::IconType::Disconnect, QColor("#efefef"), 20));
    voiceBarDisconnect_->setToolTip("Desconectar");
    connect(voiceBarDisconnect_, &QPushButton::clicked, this, &MainWindow::leaveRoom);
    vcTop->addWidget(voiceBarDisconnect_, 0, Qt::AlignVCenter);
    vcLayout->addLayout(vcTop);
    auto* vcButtons = new QHBoxLayout; vcButtons->setContentsMargins(0, 0, 0, 0); vcButtons->setSpacing(8);
    auto makeRtcButton = [this](const char* name, DiscordIcons::IconType icon, const QString& tip) {
        auto* button = new QPushButton(voiceConnectionBar_);
        button->setObjectName(name); button->setFixedHeight(32); button->setIconSize(QSize(20, 20));
        button->setIcon(DiscordIcons::icon(icon, QColor("#dcdcdf"), 20));
        button->setToolTip(tip); installDiscordTooltip(button);
        return button;
    };
    // Normal-state tooltips were not observable (Discord blocks camera/sharing in this region).
    auto* rtcCamera = makeRtcButton("rtcCameraButton", DiscordIcons::IconType::Video, "Ligar Câmera");
    auto* rtcShare = makeRtcButton("rtcShareButton", DiscordIcons::IconType::ScreenArrow, "Compartilhar Tela");
    rtcSounds_ = makeRtcButton("rtcSoundboardButton", DiscordIcons::IconType::Soundboard, "Painel de Sons");
    for (auto* button : {rtcCamera, rtcShare, rtcSounds_}) vcButtons->addWidget(button, 1);
    vcLayout->addLayout(vcButtons);
    voiceConnectionBar_->hide();
    // Observed while streaming (SHARE.md): a 57px section above "Voz conectada" with the source icon, its name
    // and a button that stops the stream; separated from the voice section by a 1px line.
    auto* streamSection = new QWidget(accountCard); streamSection->setObjectName("voiceStreamSection");
    streamSection->setAttribute(Qt::WA_StyledBackground); streamSection->setFixedHeight(57);
    auto* streamLayout = new QHBoxLayout(streamSection); streamLayout->setContentsMargins(12, 0, 11, 1); streamLayout->setSpacing(8);
    auto* streamIcon = new QLabel(streamSection); streamIcon->setObjectName("voiceStreamIcon"); streamIcon->setFixedSize(32, 32);
    streamIcon->setAlignment(Qt::AlignCenter);
    auto* streamName = new ElidedLabel(QString(), streamSection); streamName->setObjectName("voiceStreamName");
    auto* streamStop = new QPushButton(streamSection); streamStop->setObjectName("voiceStreamStop");
    streamStop->setFixedSize(32, 32); streamStop->setIconSize(QSize(20, 20));
    setHoverIcons(streamStop, DiscordIcons::icon(DiscordIcons::IconType::ScreenX, QColor("#96979e"), 20),
                  DiscordIcons::icon(DiscordIcons::IconType::ScreenX, QColor("#efefef"), 20));
    streamStop->setToolTip("Parar Transmissão"); installDiscordTooltip(streamStop);
    streamLayout->addWidget(streamIcon); streamLayout->addWidget(streamName, 1); streamLayout->addWidget(streamStop);
    streamSection->hide();
    cardLayout->addWidget(streamSection);
    cardLayout->addWidget(voiceConnectionBar_);
    installDiscordTooltip(voiceBarDisconnect_);

    // Account panel observed in Discord (desktop/out/claude-observations/ACCOUNT_PANEL.md):
    // floating 58px card, 8px from the column edges, user block + mic/headphone split controls + gear.
    auto* userAccountPanel = new QWidget(accountCard); userAccountPanel->setObjectName("userAccountRow");
    userAccountPanel->setFixedHeight(56);
    auto* userLayout = new QHBoxLayout(userAccountPanel); userLayout->setContentsMargins(7, 7, 11, 7); userLayout->setSpacing(8);
    auto* userInfo = new QWidget(userAccountPanel); userInfo->setObjectName("userAccountInfo");
    userInfo->setAttribute(Qt::WA_StyledBackground); userInfo->setAttribute(Qt::WA_Hover);
    userInfo->setFixedHeight(42);
    userInfo->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(userInfo, &QWidget::customContextMenuRequested, this, [this, userInfo](const QPoint& pos) {
        QMenu menu(userInfo);
        auto* editName = menu.addAction("Editar Perfil...");
        auto* copyId = menu.addAction("Copiar ID de Usuário");
        menu.addSeparator();
        auto* googleAction = menu.addAction(authSession_.isValid() ? "Sair da conta Google" : "Entrar com Google");
        auto* selected = menu.exec(userInfo->mapToGlobal(pos));
        if (selected == googleAction) {
            if (authSession_.isValid()) signOutOfGoogle(); else signInWithGoogle();
        } else if (selected == editName) {
            openEditProfileDialog();
        } else if (selected == copyId) {
            QGuiApplication::clipboard()->setText(userId_);
            showNotice("ID de usuário copiado para a área de transferência.");
        }
    });
    // Left click reconstructs the account popover observed in Discord (CONTA_POPOVER.md): see
    // buildAccountPopover's own comment for which rows are real and which were deliberately left out.
    struct AccountPopoverClickFilter : QObject {
        std::function<void()> onClick;
        bool eventFilter(QObject*, QEvent* event) override {
            if (event->type() == QEvent::MouseButtonRelease &&
                static_cast<QMouseEvent*>(event)->button() == Qt::LeftButton) { onClick(); return true; }
            return false;
        }
    };
    auto* popoverFilter = new AccountPopoverClickFilter; popoverFilter->setParent(userInfo);
    popoverFilter->onClick = [this, userInfo] {
        auto* menu = buildAccountPopover(userInfo, username_.isEmpty() ? "Usuário" : username_,
            userTagLabel_ ? userTagLabel_->text() : QString(), signaling_.ready(), authSession_.isValid(),
            [this] { openEditProfileDialog(); },
            [this] { if (authSession_.isValid()) signOutOfGoogle(); else signInWithGoogle(); });
        menu->ensurePolished();
        const QSize size = menu->sizeHint();
        // Observed: popover anchored above the user block, left edges aligned.
        menu->popup(userInfo->mapToGlobal(QPoint(0, -size.height() - 8)));
    };
    userInfo->installEventFilter(popoverFilter);
    auto* userInfoLayout = new QHBoxLayout(userInfo); userInfoLayout->setContentsMargins(4, 0, 4, 0); userInfoLayout->setSpacing(8);
    userAvatarLabel_ = new QLabel(userInfo); userAvatarLabel_->setFixedSize(32, 32);
    auto* userTextLayout = new QVBoxLayout; userTextLayout->setContentsMargins(0, 0, 0, 0); userTextLayout->setSpacing(0);
    userNameLabel_ = new ElidedLabel(username_.isEmpty() ? "Usuário" : username_, userInfo);
    userNameLabel_->setObjectName("userNameLabel");
    userTagLabel_ = new ElidedLabel(userInfo);
    userTagLabel_->setObjectName("userTagLabel");
    userTextLayout->addStretch(1);
    userTextLayout->addWidget(userNameLabel_);
    userTextLayout->addWidget(userTagLabel_);
    userTextLayout->addStretch(1);
    userInfoLayout->addWidget(userAvatarLabel_);
    userInfoLayout->addLayout(userTextLayout, 1);
    userLayout->addWidget(userInfo, 1);

    auto openVoiceSettings = [this, settingsDialog, settingsNav] {
        camera_.requestDevices(); settingsDialog->setGeometry(rect()); settingsDialog->show(); settingsDialog->raise();
        emit settingsNav->itemClicked(settingsNav->item(2));
    };
    micGroup_ = new SplitAudioButton("micGroup", userAccountPanel);
    userMuteButton_ = micGroup_->toggle(); userMuteButton_->setObjectName("userMuteButton");
    micGroup_->options()->setObjectName("userMuteOptionsButton");
    micGroup_->options()->setToolTip("Opções de entrada");
    mute_ = userMuteButton_;
    connect(userMuteButton_, &QPushButton::toggled, this, [this](bool muted) {
        // Observed: unmuting while deafened clears both states.
        if (!muted && deafen_ && deafen_->isChecked()) { QSignalBlocker block(deafen_); deafen_->setChecked(false); setSelfDeafened(false); }
        refreshAudioControls();
        applyMicrophoneState();
    });
    connect(micGroup_->options(), &QPushButton::clicked, this, [this, openVoiceSettings] {
        showAudioOptionsMenu(micGroup_, {"Dispositivo de entrada", "Volume de entrada", inputDevice_,
                                         findChild<QSlider*>("inputVolumeSlider"), openVoiceSettings});
    });

    deafenGroup_ = new SplitAudioButton("deafenGroup", userAccountPanel);
    userDeafenButton_ = deafenGroup_->toggle(); userDeafenButton_->setObjectName("userDeafenButton");
    deafenGroup_->options()->setObjectName("userDeafenOptionsButton");
    deafenGroup_->options()->setToolTip("Opções de saída");
    deafen_ = userDeafenButton_;
    connect(userDeafenButton_, &QPushButton::toggled, this, [this](bool deafened) {
        // Observed: deafening also mutes; undeafening restores the previous microphone state.
        QSignalBlocker block(mute_);
        if (deafened) { mutedBeforeDeafen_ = mute_->isChecked(); mute_->setChecked(true); }
        else mute_->setChecked(mutedBeforeDeafen_);
        setSelfDeafened(deafened);
        refreshAudioControls();
        applyMicrophoneState();
    });
    connect(deafenGroup_->options(), &QPushButton::clicked, this, [this, openVoiceSettings] {
        showAudioOptionsMenu(deafenGroup_, {"Dispositivo de saída", "Volume de saída", outputDevice_,
                                            findChild<QSlider*>("outputVolumeSlider"), openVoiceSettings});
    });

    auto* userSettings = new QPushButton(userAccountPanel);
    userSettings->setObjectName("userSettingsButton");
    userSettings->setFixedSize(32, 32);
    userSettings->setIconSize(QSize(20, 20));
    setHoverIcons(userSettings, DiscordIcons::icon(DiscordIcons::IconType::Settings, QColor("#96979e"), 20),
                  DiscordIcons::icon(DiscordIcons::IconType::Settings, QColor("#efefef"), 20));
    userSettings->setToolTip("Configurações de usuário");
    connect(userSettings, &QPushButton::clicked, this, [this, settingsDialog] {
        camera_.requestDevices(); settingsDialog->setGeometry(rect()); settingsDialog->show(); settingsDialog->raise(); settingsDialog->setFocus();
    });
    for (QWidget* control : {static_cast<QWidget*>(userMuteButton_), static_cast<QWidget*>(micGroup_->options()),
                             static_cast<QWidget*>(userDeafenButton_), static_cast<QWidget*>(deafenGroup_->options()),
                             static_cast<QWidget*>(userSettings)})
        installDiscordTooltip(control);
    userLayout->addWidget(micGroup_);
    userLayout->addWidget(deafenGroup_);
    userLayout->addWidget(userSettings);
    cardLayout->addWidget(userAccountPanel);
    accountCard->setFixedHeight(58);
    floatAtBottom(accountCard, leftColumn, 8);
    accountCard_ = accountCard;
    updateUserProfile();
    refreshAudioControls();
    applyMicrophoneState();

    auto* center = new QWidget(splitter); center->setObjectName("centerColumn"); center->setAttribute(Qt::WA_StyledBackground); auto* centerColumns = new QHBoxLayout(center); centerColumns->setContentsMargins(0, 0, 0, 0); centerColumns->setSpacing(0);
    auto* centerMain = new CenterSurface(center); centerMain->setObjectName("centerMain"); centerSurface_ = centerMain; centerColumns->addWidget(centerMain, 1);
    auto* centerOuter = new QVBoxLayout(centerMain); centerOuter->setContentsMargins(0, 0, 0, 0); centerOuter->setSpacing(0);

    // Observed channel header: 48px + full-width divider, 20px channel glyph in a 24px box at x=12,
    // name 16px 7px after it (Discord: icon at x=388, name at x=419 of the client; the 1px splitter
    // handle shifts this column by one). Weight 700 approximates gg sans with the fallback font. No topic is shown for voice channels; the header actions
    // (threads, notifications, pins, members, search, chat) are not mapped yet.
    auto* channelHeader = new QWidget(center); channelHeader->setObjectName("channelHeader");
    channelHeader->setAttribute(Qt::WA_StyledBackground); channelHeader->setFixedHeight(49);
    auto* chLayout = new QHBoxLayout(channelHeader); chLayout->setContentsMargins(12, 0, 8, 1); chLayout->setSpacing(7);
    auto* chIcon = new QLabel(channelHeader);
    chIcon->setPixmap([] { QPixmap px(24, 24); px.fill(Qt::transparent); QPainter p(&px);
        DiscordIcons::paint(&p, DiscordIcons::IconType::VoiceSpeaker, QRectF(2, 2, 20, 20), QColor("#96979e")); return px; }());
    chIcon->setFixedSize(24, 24);
    channelHeaderTitle_ = new QLabel("Geral", channelHeader); channelHeaderTitle_->setObjectName("channelHeaderTitle");
    chLayout->addWidget(chIcon);
    chLayout->addWidget(channelHeaderTitle_);
    // Observed focused viewer: a dot, the owner's avatar and "Tela de <nome>" after the channel name, and the
    // quality and "AO VIVO" pills at the right end of the header.
    focusSeparator_ = new QLabel(channelHeader); focusSeparator_->setObjectName("headerFocusDot"); focusSeparator_->setFixedSize(4, 4);
    focusAvatar_ = new QLabel(channelHeader); focusAvatar_->setFixedSize(24, 24);
    focusTitle_ = new QLabel(channelHeader); focusTitle_->setObjectName("channelHeaderFocusTitle");
    chLayout->addWidget(focusSeparator_, 0, Qt::AlignVCenter); chLayout->addWidget(focusAvatar_); chLayout->addWidget(focusTitle_);
    chLayout->addStretch(1);
    qualityPill_ = new QLabel(channelHeader); qualityPill_->setObjectName("headerQualityPill");
    livePill_ = new QLabel("AO VIVO", channelHeader); livePill_->setObjectName("headerLivePill");
    chLayout->addWidget(qualityPill_, 0, Qt::AlignVCenter); chLayout->addWidget(livePill_, 0, Qt::AlignVCenter);
    for (auto* w : {static_cast<QWidget*>(focusSeparator_), static_cast<QWidget*>(focusAvatar_), static_cast<QWidget*>(focusTitle_),
                    static_cast<QWidget*>(qualityPill_), static_cast<QWidget*>(livePill_)}) w->hide();
    chatToggle_ = new QPushButton(channelHeader); chatToggle_->setObjectName("voiceChatToggle");
    chatToggle_->setFixedSize(32, 32); chatToggle_->setIconSize(QSize(20, 20));
    setHoverIcons(chatToggle_, DiscordIcons::icon(DiscordIcons::IconType::Chat, QColor("#96979e"), 20),
                  DiscordIcons::icon(DiscordIcons::IconType::Chat, QColor("#efefef"), 20));
    chatToggle_->setToolTip("Mostrar chat");
    installDiscordTooltip(chatToggle_, TooltipPlacement::Below);
    chLayout->addWidget(chatToggle_);
    // Unread badge (BADGES.md geometry): the one real "notification count" triscord has is chat messages
    // that arrive while the chat panel is hidden; there is no multi-server or DM list to badge honestly.
    chatUnreadBadge_ = new NotificationBadge(chatToggle_);
    chatUnreadBadge_->move(chatToggle_->width() - 12, -4);
    callChrome_ = {chIcon, channelHeaderTitle_};
    watchHover(center, [this](bool hovered) { centerHovered_ = hovered; updateCallChrome(); });
    centerOuter->addWidget(channelHeader);
    channelHeader_ = channelHeader;
    centerOuter->addWidget(status_);
    // Not in a room: the observed voice channel view before joining. In a room: call area and chat.
    centerStack_ = new QStackedWidget(center); centerStack_->setObjectName("centerStack");
    prejoin_ = new VoicePrejoinView(centerStack_);
    connect(prejoin_, &VoicePrejoinView::joinRequested, this, [this] {
        for (const auto& value : roomDirectory_) {
            const auto room = value.toObject();
            if (room.value("id").toString() == viewedRoomId_) { joinRoom(viewedRoomId_, room.value("name").toString()); return; }
        }
    });
    auto* centerBody = new QWidget(centerStack_); centerBody->setObjectName("centerBody"); centerBody_ = centerBody;
    auto* centerRow = new QHBoxLayout(centerBody); centerRow->setContentsMargins(0, 0, 0, 49); centerRow->setSpacing(0);
    auto* stage = new QWidget(centerBody); stage->setObjectName("callStage");
    auto* centerLayout = new QVBoxLayout(stage); centerLayout->setContentsMargins(0, 0, 0, 0); centerLayout->setSpacing(0);
    centerRow->addWidget(stage, 1);
    centerStack_->addWidget(prejoin_);
    centerStack_->addWidget(centerBody);
    centerOuter->addWidget(centerStack_, 1);

    auto* callCards = new QScrollArea(stage); callCards->setObjectName("callCardsScroll"); callCards->setFrameShape(QFrame::NoFrame);
    callCards->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff); callCards->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    callCards->setWidgetResizable(true); callCards->setMinimumHeight(100); callCards->hide();
    participantCards_ = new ParticipantPane(callCards); callCards->setWidget(participantCards_);
    auto* cameraView = new CameraView(this);
    auto focusCamera = [this, cameraView, shareSession](const QString&) {
        const auto id = cameraView->isVisible() ? cameraView->peer() : participantCards_->focusedPeer();
        const bool stream = ParticipantPane::isStreamKey(id);
        // A shared screen is looked at through the share session; the camera focus only follows participants.
        shareSession->setViewedStream(stream ? id.mid(7) : QString());
        camera_.setFocus(stream ? QString() : (!id.isEmpty() && id == signaling_.socketId() ? "$local" : id));
        updateFocusHeader();
    };
    connect(participantCards_, &ParticipantPane::focusChanged, this, focusCamera);
    connect(cameraView, &CameraView::focusChanged, this, [this, focusCamera](const QString& id) {
        if (!id.isEmpty() && !ParticipantPane::isStreamKey(id)) camera_.setFocus(id == signaling_.socketId() ? "$local" : id);
        else focusCamera({});
    });
    connect(participantCards_, &ParticipantPane::fullscreenRequested, cameraView, &CameraView::openPeer);
    connect(shareSession, &ShareSession::streamsChanged, participantCards_, &ParticipantPane::setStreams);
    connect(shareSession, &ShareSession::streamsChanged, this, [this](const QVector<StreamTile>&) { updateFocusHeader(); });
    connect(shareSession, &ShareSession::streamFrame, this, [this, cameraView](const QString& id, const QImage& image) {
        participantCards_->setStreamFrame(id, image); cameraView->setFrame(ParticipantPane::streamKey(id), image);
        if (participantCards_->focusedPeer() == ParticipantPane::streamKey(id)) updateFocusHeader();
    });
    connect(shareSession, &ShareSession::streamFrameRemoved, this, [this, cameraView](const QString& id) {
        participantCards_->removeStreamFrame(id); cameraView->removePeer(ParticipantPane::streamKey(id));
    });
    connect(cameraView, &CameraView::returnToGridRequested, participantCards_, &ParticipantPane::clearFocusPeer);
    connect(&camera_, &CameraPublisher::image, this, [this, cameraView](const QString& id, const QImage& image) {
        const auto peer = id == "$local" ? signaling_.socketId() : id;
        participantCards_->setFrame(peer, image); cameraView->setFrame(peer, image);
    });
    connect(&camera_, &CameraPublisher::removed, this, [this, cameraView](const QString& id) {
        const auto peer = id == "$local" ? signaling_.socketId() : id;
        participantCards_->removeFrame(peer); cameraView->removePeer(peer);
    });
    connect(&camera_, &CameraPublisher::message, this, &MainWindow::showNotice);
    connect(&voice_, &VoiceService::speakingChanged, participantCards_, &ParticipantPane::setSpeaking);
    connect(&voice_, &VoiceService::speakingWhileMuted, this, [this] {
        if (pushToTalk_ && !mute_->isChecked()) return;
        const auto now = QDateTime::currentMSecsSinceEpoch();
        if (now - lastMutedNotice_ > 3000) {
            lastMutedNotice_ = now;
            showNotice("Voce esta mutado.");
        }
    });
    connect(&voice_, &VoiceService::speakingChanged, this, [this](const QString& peer, bool speaking) {
        if (speaking) speakingPeers_.insert(peer);
        else speakingPeers_.remove(peer);
        screen_.setDucking(!speakingPeers_.isEmpty());
    });
    // Observed: the voice channel chat is a side panel opened from the header, not a split below the call.
    chat_ = new ChatPane(center); chat_->setObjectName("chatList"); chat_->setCurrentUser(userId_); chat_->setMinimumHeight(80);
    settings.remove("mediaChatSplit");
    settings.remove("callLayoutSplit");
    centerLayout->addWidget(callCards, 1);
    connect(chat_, &ChatPane::linkRequested, this, [](const QUrl& url) { QDesktopServices::openUrl(url); });
    connect(chat_, &ChatPane::reactionRequested, this, [this](const QString& id, const QString& emoji) {
        if (!roomId_.isEmpty()) signaling_.sendEvent("add-reaction", {{"messageId", id}, {"emoji", emoji}});
    });
    connect(chat_, &ChatPane::deleteRequested, this, [this](const QString& id) {
        if (!roomId_.isEmpty()) signaling_.sendEvent("delete-chat-message", {{"messageId", id}, {"roomId", roomId_}});
    });
    auto* people = new QWidget(splitter); people->setObjectName("peoplePanel"); people->setMinimumWidth(180);
    auto* peopleLayout = new QVBoxLayout(people); peopleLayout->setContentsMargins(10, 16, 10, 10);
    memberCount_ = new QLabel("ONLINE — 0", people); memberCount_->setObjectName("sectionTitle"); peopleLayout->addWidget(memberCount_);
    members_ = new QListWidget(people); members_->setObjectName("memberList"); members_->setSpacing(0);
    members_->setTextElideMode(Qt::ElideRight); members_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    peopleLayout->addWidget(members_, 1);
    members_->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(members_, &QWidget::customContextMenuRequested, this, [this](const QPoint& position) {
        auto* item = members_->itemAt(position); if (!item) return;
        const auto id = item->data(Qt::UserRole).toString();
        if (id.isEmpty() || (id == signaling_.socketId() && !(owner_ && serverMuted_))) return;
        showUserContextMenu(id, item->text().section('\n', 0, 0), members_->viewport()->mapToGlobal(position));
    });
    splitter->setStretchFactor(0, 0); splitter->setStretchFactor(1, 1); splitter->setStretchFactor(2, 0);
    // Channel sidebar observed at 303px in Discord (1280x900, 96 DPI). The key is versioned so widths
    // saved for the previous layout, which clipped the account panel, do not override it.
    // Observed left column: 72px rail + 303px sidebar. Widths saved for earlier layouts are dropped.
    // Fixed 375px left column (72 rail + 303 sidebar) with no visible handle: the content starts at x=375 as in
    // Discord, where the sidebar edge is only a colour step and the sidebar is not resizable.
    splitter->setSizes({375, 420, 200});
    settings.remove("roomColumns"); settings.remove("roomColumnsV2"); settings.remove("roomColumnsV3");
    splitter->restoreState(settings.value("roomColumnsV4").toByteArray());
    connect(splitter, &QSplitter::splitterMoved, this, [splitter](int, int) { QSettings().setValue("roomColumnsV4", splitter->saveState()); });
    callLayout->addWidget(splitter);
    // Voice channel chat panel observed in Discord (desktop/out/claude-observations/CHAT.md): 450px on the
    // right, 48px header (chat icon, channel name, close) with divider, messages, and the 58px composer
    // 8px from the edges. Discord's composer has no send button (Enter sends); its "+" (attachments),
    // emoji and apps buttons have no triscord function and are not drawn.
    // Observed: the panel spans the full content height, its header beside the channel header.
    chatPanel_ = new QWidget(center); chatPanel_->setObjectName("voiceChatPanel");
    chatPanel_->setAttribute(Qt::WA_StyledBackground); chatPanel_->setFixedWidth(450);
    auto* chatPanelLayout = new QVBoxLayout(chatPanel_); chatPanelLayout->setContentsMargins(1, 0, 0, 0); chatPanelLayout->setSpacing(0);
    auto* chatHeader = new QWidget(chatPanel_); chatHeader->setObjectName("voiceChatHeader");
    chatHeader->setAttribute(Qt::WA_StyledBackground); chatHeader->setFixedHeight(49);
    auto* chatHeaderLayout = new QHBoxLayout(chatHeader); chatHeaderLayout->setContentsMargins(16, 0, 12, 1); chatHeaderLayout->setSpacing(8);
    auto* chatHeaderIcon = new QLabel(chatHeader); chatHeaderIcon->setFixedSize(20, 20);
    chatHeaderIcon->setPixmap(DiscordIcons::pixmap(DiscordIcons::IconType::Chat, QColor("#96979e"), 20));
    chatPanelTitle_ = new QLabel("Geral", chatHeader); chatPanelTitle_->setObjectName("voiceChatTitle");
    auto* chatClose = new QPushButton(chatHeader); chatClose->setObjectName("voiceChatClose");
    chatClose->setFixedSize(32, 32); chatClose->setIconSize(QSize(20, 20));
    setHoverIcons(chatClose, DiscordIcons::icon(DiscordIcons::IconType::Close, QColor("#96979e"), 20),
                  DiscordIcons::icon(DiscordIcons::IconType::Close, QColor("#efefef"), 20));
    chatHeaderLayout->addWidget(chatHeaderIcon);
    chatHeaderLayout->addWidget(chatPanelTitle_, 1);
    chatHeaderLayout->addWidget(chatClose);
    chatPanelLayout->addWidget(chatHeader);
    chatPanelLayout->addWidget(chat_, 1);
    auto* composeContainer = new QWidget(chatPanel_); composeContainer->setObjectName("channelTextArea");
    composeContainer->setAttribute(Qt::WA_StyledBackground);
    auto* compose = new QHBoxLayout(composeContainer); compose->setContentsMargins(16, 0, 16, 0); compose->setSpacing(0);
    message_ = new ChannelComposer(composeContainer);
    message_->setObjectName("chatComposer");
    message_->setAccessibleName("mensagem");
    message_->setPlaceholderText("Conversar em Geral");
    message_->setMaxLength(2000);
    compose->addWidget(message_, 1);
    auto* composeMargin = new QWidget(chatPanel_);
    auto* composeMarginLayout = new QVBoxLayout(composeMargin); composeMarginLayout->setContentsMargins(8, 8, 8, 8);
    composeMarginLayout->addWidget(composeContainer);
    chatPanelLayout->addWidget(composeMargin);
    centerColumns->addWidget(chatPanel_);
    chatPanel_->hide();
    connect(chatToggle_, &QPushButton::clicked, this, [this] {
        chatPanel_->show(); updateCallChrome(); message_->setFocus();
        unreadChatCount_ = 0;
        if (chatUnreadBadge_) chatUnreadBadge_->setCount(0);
    });
    connect(chatClose, &QPushButton::clicked, this, [this] { chatPanel_->hide(); updateCallChrome(); });
    // Call control bar observed in Discord (CALLS.md): 50px capsules (#0a0a0c, 1px border) 14px apart,
    // centred; group 1 = microphone split (36+1+16 x 40) + camera, group 2 = soundboard, then a red
    // 64x50 disconnect button. Screen sharing sits after the camera: Discord blocks it in this region, so
    // its own position was not observable. Invite, activities, "Mais opções", popout and fullscreen have
    // no triscord function here.
    callControlsDock_ = new QWidget(centerBody);
    callControlsDock_->setObjectName("callControlsDock");
    auto* dockLayout = new QHBoxLayout(callControlsDock_);
    dockLayout->setContentsMargins(0, 0, 0, 16);
    // Observed: the bar area stays reserved (cards do not move) while the bar itself shows on hover.
    callControlsDock_->setFixedHeight(66);
    dockLayout->setSpacing(14);
    dockLayout->setAlignment(Qt::AlignCenter);
    auto makeCapsule = [this](const char* name) {
        auto* capsule = new QWidget(callControlsDock_); capsule->setObjectName(name);
        capsule->setAttribute(Qt::WA_StyledBackground); capsule->setFixedHeight(50);
        auto* l = new QHBoxLayout(capsule); l->setContentsMargins(5, 5, 5, 5); l->setSpacing(4);
        return std::pair{capsule, l};
    };
    auto [mediaCapsule, mediaLayout] = makeCapsule("callMediaGroup");
    auto [extrasCapsule, extrasLayout] = makeCapsule("callExtrasGroup");
    auto makeBarButton = [](QWidget* parent, const char* name, DiscordIcons::IconType icon, const QString& tip) {
        auto* button = new QPushButton(parent); button->setObjectName(name);
        button->setFixedSize(40, 40); button->setIconSize(QSize(20, 20));
        button->setIcon(DiscordIcons::icon(icon, QColor("#dcdcdf"), 20));
        button->setToolTip(tip); installDiscordTooltip(button);
        return button;
    };
    barMicGroup_ = new SplitAudioButton("barMicGroup", mediaCapsule);
    barMicGroup_->setFixedSize(53, 40);
    barMicGroup_->toggle()->setFixedSize(36, 40);
    barMicGroup_->options()->setFixedSize(16, 40);
    barMicGroup_->findChild<QWidget*>("splitDivider")->setFixedSize(1, 40);
    barMicGroup_->options()->setObjectName("barMicOptionsButton");
    barMicGroup_->options()->setToolTip("Opções de entrada");
    installDiscordTooltip(barMicGroup_->toggle()); installDiscordTooltip(barMicGroup_->options());
    connect(barMicGroup_->toggle(), &QPushButton::clicked, this, [this] { if (mute_->isEnabled()) mute_->click(); refreshAudioControls(); });
    connect(barMicGroup_->options(), &QPushButton::clicked, this, [this] { if (micGroup_) micGroup_->options()->click(); });
    mediaLayout->addWidget(barMicGroup_);

    auto* cameraButton = makeBarButton(mediaCapsule, "cameraButton", DiscordIcons::IconType::Video, "Ligar Câmera");
    cameraButton->setCheckable(true);
    cameraButton->setEnabled(false);
    mediaLayout->addWidget(cameraButton);
    connect(&camera_, &CameraPublisher::roomChanged, cameraButton, &QPushButton::setEnabled);
    connect(cameraButton, &QPushButton::toggled, this, [this](bool active) {
        if (active) camera_.start(QSettings().value("cameraDevice").toByteArray()); else camera_.stop();
    });
    connect(&camera_, &CameraPublisher::publishingChanged, cameraButton, [cameraButton](bool active) {
        QSignalBlocker blocker(cameraButton);
        cameraButton->setChecked(active);
        cameraButton->setToolTip(active ? "Desligar Câmera" : "Ligar Câmera");
    });

    auto* share = makeBarButton(mediaCapsule, "shareScreenButton", DiscordIcons::IconType::ScreenArrow, "Compartilhar Tela");
    share->setEnabled(false);
    mediaLayout->addWidget(share);
    connect(&screen_, &ScreenService::roomChanged, share, &QPushButton::setEnabled);
    connect(share, &QPushButton::clicked, shareSession, &ShareSession::chooseSource);

    sounds_ = makeBarButton(extrasCapsule, "soundboardButton", DiscordIcons::IconType::Soundboard, "Painel de Sons");
    sounds_->setEnabled(false);
    extrasLayout->addWidget(sounds_);
    dockLayout->addWidget(mediaCapsule);
    dockLayout->addWidget(extrasCapsule);
    // Observed: the soundboard popover opens anchored above the button that was clicked.
    connect(sounds_, &QPushButton::clicked, this, [this] { soundboard_->popupFor(sounds_); });

    leaveRoomButton->setText(QString());
    leaveRoomButton->setFixedSize(64, 50);
    leaveRoomButton->setIcon(DiscordIcons::icon(DiscordIcons::IconType::Disconnect, Qt::white, 24));
    leaveRoomButton->setIconSize(QSize(24, 24));
    leaveRoomButton->setToolTip("Desconectar");
    installDiscordTooltip(leaveRoomButton);
    leaveRoomButton->setParent(callControlsDock_);
    dockLayout->addWidget(leaveRoomButton);
    callChrome_ << mediaCapsule << extrasCapsule << leaveRoomButton;

    connect(rtcCamera, &QPushButton::clicked, cameraButton, &QPushButton::click);
    // Panel share button: stops the stream while it is live (inferred: Discord shows the stop glyph on it), otherwise opens the picker.
    connect(rtcShare, &QPushButton::clicked, this, [this, rtcShare, share] { if (rtcShare->property("live").toBool()) screen_.stop(); else share->click(); });
    connect(rtcSounds_, &QPushButton::clicked, this, [this] { if (sounds_->isEnabled()) soundboard_->popupFor(rtcSounds_); });
    connect(&camera_, &CameraPublisher::roomChanged, rtcCamera, &QPushButton::setEnabled);
    connect(&screen_, &ScreenService::roomChanged, rtcShare, &QPushButton::setEnabled);
    {
        const QColor live("#62b77c");
        auto setLive = [](QPushButton* button, bool value) {
            button->setProperty("live", value);
            button->style()->unpolish(button); button->style()->polish(button);
        };
        auto refreshCard = [this] { if (accountCard_ && voiceConnectionBar_) showCenterState(); };
        connect(&camera_, &CameraPublisher::publishingChanged, this, [this, rtcCamera, setLive, live](bool active) {
            setLive(rtcCamera, active);
            rtcCamera->setIcon(DiscordIcons::icon(DiscordIcons::IconType::Video, active ? live : Qt::white, 20));
            rtcCamera->setToolTip(active ? "Desligar Câmera" : "Ligar Câmera");
            if (auto* title = findChild<QLabel*>("voiceConnectedTitle")) {
                title->setText(active ? "Vídeo conectado" : "Voz conectada");
                title->setProperty("video", active);
                title->style()->unpolish(title); title->style()->polish(title);
            }
        });
        connect(shareSession, &ShareSession::sharedSourceChanged, this, [this, streamSection, streamIcon, streamName, refreshCard](const QString& title, const QPixmap& icon) {
            streamName->setText(title);
            streamIcon->setPixmap(icon.isNull() ? QPixmap() : icon.scaled(32, 32, Qt::KeepAspectRatio, Qt::SmoothTransformation));
            streamSection->setVisible(!title.isEmpty());
            refreshCard();
        });
        connect(&screen_, &ScreenService::sharingChanged, this, [rtcShare, setLive, live](bool active) {
            setLive(rtcShare, active);
            rtcShare->setIcon(DiscordIcons::icon(active ? DiscordIcons::IconType::ScreenX : DiscordIcons::IconType::ScreenArrow, active ? live : Qt::white, 20));
            rtcShare->setToolTip(active ? "Parar Transmissão" : "Compartilhar Tela");
        });
        connect(streamStop, &QPushButton::clicked, &screen_, &ScreenService::stop);
    }
    callControlsDock_->hide();
    new DockPlacer(centerBody, callControlsDock_);

    layout->addWidget(callTab, 1);
    showCenterState();
    titleBar_ = new TitleBar(root);
    titleBar_->setContext(QPixmap(":/triscord/icon.png"), "Triscord");
    layout->insertWidget(0, titleBar_);
    setCentralWidget(root);
    setWindowFlag(Qt::FramelessWindowHint);
    enableNativeFrame(this);
    // QSS can only draw a combo arrow from an image file: render the observed chevron once into the cache directory.
    const QString chevronPath = QDir(QStandardPaths::writableLocation(QStandardPaths::CacheLocation)).filePath("combo-chevron.png");
    QDir().mkpath(QFileInfo(chevronPath).absolutePath());
    DiscordIcons::icon(DiscordIcons::IconType::ChevronSmallDown, QColor("#96979e"), 20).pixmap(20, 20).save(chevronPath);
    setStyleSheet("QWidget { background:#000000; color:#d4d5d8; font-family:\"gg sans\", \"Noto Sans\", \"Segoe UI\", Arial, sans-serif; font-size:13px; }"
        "QWidget#callControlsDock { background:transparent; border:0; }"
        "QWidget#callMediaGroup, QWidget#callExtrasGroup { background:#0a0a0c; border:1px solid #1e1e20; border-radius:12px; }"
        "QWidget#callControlsDock QPushButton, QWidget#callControlsDock QPushButton:checked, QWidget#callControlsDock QPushButton:disabled { background:transparent; border:0; border-radius:8px; padding:0; }"
        "QWidget#callControlsDock QPushButton:hover { background:#1e1e20; }"
        "QWidget#callControlsDock QPushButton:checked { background:#1e1e20; }"
        "QWidget#barMicGroup QPushButton#splitToggle { border-top-right-radius:0; border-bottom-right-radius:0; }"
        "QWidget#barMicGroup QPushButton#barMicOptionsButton { border-top-left-radius:0; border-bottom-left-radius:0; }"
        "QWidget#barMicGroup[active=\"true\"] QPushButton { background:#230e12; }"
        "QWidget#barMicGroup[active=\"true\"] QPushButton:hover { background:#321314; }"
        "QWidget#callControlsDock QPushButton#leaveCallButton { background:#d22d39; border:0; border-radius:12px; }"
        "QWidget#callControlsDock QPushButton#leaveCallButton:hover { background:#a1282c; }"
        "QWidget#voiceStreamSection { background:transparent; border:0; border-bottom:1px solid rgba(151,151,159,0.200); }"
        "QLabel#voiceStreamName { color:#dcdcdf; font-size:16px; font-weight:600; background:transparent; }"
        "QLabel#voiceStreamIcon { background:transparent; }"
        "QWidget#voiceStreamSection QPushButton#voiceStreamStop { background:transparent; border:0; border-radius:8px; padding:0; }"
        "QWidget#voiceStreamSection QPushButton#voiceStreamStop:hover { background:#3e3f45; }"
        "QWidget#voiceConnectionBar { background:transparent; border:0; border-bottom:1px solid rgba(151,151,159,0.200); }"
        "QLabel#voiceConnectedTitle { color:#7ecb94; font-size:14px; font-weight:600; }"
        "QLabel#voiceConnectedRoom { color:#96979e; font-size:12px; }"
        "QWidget#voiceConnectionBar QPushButton#voiceBarDisconnect { background:transparent; border:0; border-radius:8px; padding:0; }"
        "QWidget#voiceConnectionBar QPushButton#voiceBarDisconnect:hover { background:#3e3f45; }"
        "QPushButton#rtcCameraButton, QPushButton#rtcShareButton, QPushButton#rtcSoundboardButton { background:#414249; border:1px solid #56565e; border-radius:8px; padding:0; }"
        "QPushButton#rtcCameraButton:hover, QPushButton#rtcShareButton:hover, QPushButton#rtcSoundboardButton:hover { background:#46474e; }"
        "QPushButton#rtcCameraButton:disabled, QPushButton#rtcShareButton:disabled, QPushButton#rtcSoundboardButton:disabled { background:#262629; }"
        // Observed active state: dark green fill with the glyph in green (#62b77c over the stream/camera buttons).
        "QPushButton#rtcCameraButton[live=\"true\"], QPushButton#rtcShareButton[live=\"true\"] { background:#2f403e; border:1px solid #2a483f; }"
        "QPushButton#rtcCameraButton[live=\"true\"]:hover, QPushButton#rtcShareButton[live=\"true\"]:hover { background:#33463f; }"
        "QLabel#voiceConnectedTitle[video=\"true\"] { color:#62b77c; }"
        "QWidget#peoplePanel { background:#000000; border:0; border-top:1px solid rgba(151,151,159,0.200); }"
        "QWidget#sidebar { background:#000000; border-left:1px solid rgba(151,151,159,0.200); border-top:1px solid rgba(151,151,159,0.200); border-top-left-radius:12px; }"
        "QWidget#centerColumn { background:#000000; border-top:1px solid rgba(151,151,159,0.200); }"
        "QWidget#titleBar { background:#000000; }"
        "QWidget#serverRail { background:#000000; }"
        "QLabel#titleBarName { color:#dcdcdf; font-size:14px; font-weight:600; }"
        "QWidget#titleBar QPushButton { background:transparent; border:0; border-radius:0; padding:0; }"
        "QWidget#titleBar QPushButton:hover { background:rgba(151,151,159,0.122); }"
        "QWidget#titleBar QPushButton#windowCloseButton:hover { background:#d22d39; }"
        "QWidget#channelHeader { background:transparent; border:0; border-bottom:1px solid rgba(151,151,159,0.200); }"
        "QWidget#serverHeader { background:transparent; border:0; border-bottom:1px solid rgba(151,151,159,0.200); }"
        "QWidget#channelHeader[prejoin=\"true\"] { background:transparent; border-bottom:0; }"
        "QWidget#centerColumn[prejoin=\"true\"] { border-top:0; }"
        "QWidget#channelHeader[voiceCall=\"true\"] { background:transparent; border-bottom:0; }"
        "QWidget#centerColumn[voiceCall=\"true\"] { border-top:0; }"
        "QWidget#centerMain, QStackedWidget#centerStack, QWidget#centerBody, QWidget#callStage, QScrollArea#callCardsScroll, QScrollArea#callCardsScroll > QWidget, QScrollArea#callCardsScroll > QWidget > QWidget { background:transparent; }"
        "QWidget#voicePrejoinView { background:transparent; }"
        // Settings modal (SETTINGS.md): darkened backdrop, bordered panel, 252px nav, 48px content header.
        "QDialog#audioSettingsDialog { background:rgba(0,0,0,184); }"
        "QWidget#settingsPanel { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:8px; }"
        "QWidget#settingsSidebar { background:#000000; border:0; border-top-left-radius:8px; border-bottom-left-radius:8px; }"
        "QWidget#settingsContentArea, QWidget#settingsPageHolder, QScrollArea#settingsScroll { background:#000000; }"
        "QWidget#settingsContentHeader { background:#000000; border:0; border-bottom:1px solid rgba(151,151,159,0.200); }"
        "QLabel#settingsContentTitle { color:#dcdcdf; font-size:16px; font-weight:600; }"
        "QPushButton#btnSettingsDone { background:transparent; border:0; border-radius:8px; padding:0; }"
        "QPushButton#btnSettingsDone:hover { background:#3e3f45; }"
        "QWidget#settingsProfileHeader { background:transparent; }"
        "QLabel#settingsProfileName { color:#dcdcdf; font-size:16px; font-weight:600; }"
        "QPushButton#settingsEditProfile { background:transparent; border:0; padding:0; color:#96979e; font-size:14px; text-align:left; }"
        "QPushButton#settingsEditProfile:hover { color:#dcdcdf; }"
        "QListWidget#settingsNav { background:transparent; border:0; outline:0; }"
        "QLabel#settingsHeading { color:#dcdcdf; font-size:24px; font-weight:600; padding-bottom:3px; }"
        "QLabel#settingsRowLabel { color:#dcdcdf; font-size:16px; font-weight:600; }"
        "QLabel#settingsRowDescription { color:#96979e; font-size:14px; }"
        "QWidget#settingsDivider { background:rgba(151,151,159,0.200); }"
        "QWidget#settingsPageHolder QWidget { background:transparent; }" // observed: the page is #000000 edge to edge
        "QDialog#audioSettingsDialog QScrollBar:vertical { width:16px; background:transparent; margin:4px 0 6px 0; border:0; }"
        "QDialog#audioSettingsDialog QScrollBar::handle:vertical { background:#7d7e87; border-radius:4px; min-height:40px; margin:0 4px; }"
        "QDialog#audioSettingsDialog QScrollBar::add-line:vertical, QDialog#audioSettingsDialog QScrollBar::sub-line:vertical { height:0; width:0; }"
        "QDialog#audioSettingsDialog QScrollBar::add-page:vertical, QDialog#audioSettingsDialog QScrollBar::sub-page:vertical { background:transparent; }"
        "QDialog#audioSettingsDialog QComboBox { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:8px; padding:0 12px; color:#d4d5d8; font-size:16px; font-weight:600; }"
        "QDialog#audioSettingsDialog QComboBox::drop-down { border:0; width:32px; subcontrol-origin:padding; subcontrol-position:center right; }"
        "QDialog#audioSettingsDialog QComboBox::down-arrow { image:url(" + chevronPath + "); width:20px; height:20px; }"
        "QDialog#audioSettingsDialog QSpinBox { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:8px; padding:0 12px; color:#d4d5d8; font-size:16px; }"
        "QDialog#audioSettingsDialog QSlider::handle:horizontal { background:#ffffff; width:16px; height:16px; margin:-6px 0; border-radius:8px; }"
        "QDialog#audioSettingsDialog QSlider::groove:horizontal { height:4px; background:#4d505b; border-radius:2px; }"
        "QWidget#voiceChatPanel { background:#000000; border:0; border-left:1px solid rgba(151,151,159,0.200); }"
        "QWidget#voiceChatHeader { background:#000000; border:0; border-bottom:1px solid rgba(151,151,159,0.200); }"
        "QLabel#voiceChatTitle { font-size:16px; font-weight:700; color:#dcdcdf; }"
        "QPushButton#voiceChatToggle, QPushButton#voiceChatClose { background:transparent; border:0; border-radius:8px; padding:0; }"
        "QPushButton#voiceChatToggle:hover, QPushButton#voiceChatClose:hover { background:#3e3f45; }"
        "QLabel#voicePrejoinTitle { font-size:30px; font-weight:700; color:#dcdcdf; }"
        "QLabel#voicePrejoinSubtitle { font-size:14px; color:#d4d5d8; }"
        "QPushButton#voicePrejoinJoinButton { background:#ffffff; color:#000000; border:0; border-radius:8px; padding:0 16px; font-size:16px; font-weight:500; }"
        "QPushButton#voicePrejoinJoinButton:hover { background:#e0e0e3; color:#000000; }"
        "QPushButton#voicePrejoinJoinButton:disabled { background:#ffffff; color:#7a7b83; }"
        "QLabel#serverTitle, QLabel#channelHeaderTitle { font-size:16px; font-weight:700; color:#dcdcdf; }"
        "QLabel#channelHeaderFocusTitle { font-size:16px; font-weight:500; color:#dcdcdf; }"
        "QLabel#headerFocusDot { background:#81828a; border-radius:2px; }"
        "QLabel#headerQualityPill, QLabel#headerLivePill { color:#dcdcdf; font-size:11px; font-weight:700; padding:0 7px; border-radius:4px; min-height:16px; max-height:16px; }"
        "QLabel#headerQualityPill { background:#4f505a; }"
        "QLabel#headerLivePill { background:#d22d39; }"
        "QListWidget#roomList::item, QListWidget#roomList::item:hover, QListWidget#roomList::item:selected { background:transparent; padding:0; margin:0; border:0; }"
        "QSlider::groove:horizontal { height:6px; background:#4d505b; border-radius:3px; }"
        "QSlider::sub-page:horizontal { background:#5865f2; border-radius:3px; }"
        "QSlider::handle:horizontal { background:#ffffff; width:14px; height:14px; margin:-4px 0; border-radius:7px; }"
        "QLabel { background:transparent; }"
        "QLabel#sectionTitle { font-size:11px; font-weight:700; color:#949ba4; letter-spacing:0.5px; }"
        "QLabel#connectionStatus { background-color:#da373c; color:#dcdcdf; font-size:13px; font-weight:600; padding:6px 14px; border-radius:4px; margin:2px 0; }"
        "QLineEdit, QComboBox { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:6px; padding:7px 10px; color:#d4d5d8; }"
        "QLineEdit:focus, QComboBox:focus { border:1px solid #5865f2; }"
        "QListWidget { background:transparent; border:0; outline:0; }"
        "QListWidget::item { padding:8px 10px; border-radius:4px; margin:1px 0; color:#949ba4; }"
        "QListWidget#roomList::item { font-weight:500; font-size:13px; }"
        "QListWidget#roomList::item:hover { background:rgba(151,151,159,0.122); color:#dcdcdf; }"
        "QListWidget#roomList::item:selected { background:#414248; color:#dcdcdf; }"
        "QListWidget#memberList::item { padding:6px 4px; border-radius:6px; }"
        "QListWidget#memberList::item:hover { background:rgba(151,151,159,0.122); color:#dcdcdf; }"
        "QListWidget#memberList::item:selected { background:#414248; color:#dcdcdf; }"
        "QPushButton, QToolButton { background:#414249; border:1px solid #56565e; border-radius:6px; padding:7px 12px; color:#d4d5d8; font-weight:500; }"
        "QPushButton:hover, QToolButton:hover { background:#46474e; border-color:rgba(151,151,159,0.439); color:#dcdcdf; }"
        "QPushButton:pressed { background:rgba(151,151,159,0.200); }"
        "QPushButton:checked { background:rgba(151,151,159,0.239); border-color:#5865f2; color:#dcdcdf; }"
        "QPushButton:disabled { background:#000000; border-color:rgba(151,151,159,0.200); color:#4d505b; }"
        "QPushButton#createRoomButton, QPushButton#createRoomButton:hover, QPushButton#createRoomButton:disabled { background:transparent; border:0; padding:0; }"
        // Account panel geometry/states observed in Discord; colours are the black-theme adaptation.
        "QWidget#userAccountPanel { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:8px; }"
        "QWidget#userAccountRow { background:transparent; }"
        "QWidget#userAccountInfo { background:transparent; border-radius:8px; }"
        "QWidget#userAccountInfo:hover { background:#3e3f45; }"
        "QLabel#userNameLabel { font-size:14px; font-weight:600; color:#dcdcdf; }"
        "QLabel#userTagLabel { font-size:12px; color:#949ba4; }"
        "triscord--SplitAudioButton QPushButton, triscord--SplitAudioButton QPushButton:checked, triscord--SplitAudioButton QPushButton:disabled { background:transparent; border:0; padding:0; }"
        "QPushButton#userMuteButton, QPushButton#userDeafenButton { border-top-left-radius:8px; border-bottom-left-radius:8px; border-top-right-radius:0; border-bottom-right-radius:0; }"
        "QPushButton#userMuteOptionsButton, QPushButton#userDeafenOptionsButton { border-top-right-radius:8px; border-bottom-right-radius:8px; border-top-left-radius:0; border-bottom-left-radius:0; }"
        "QWidget#splitDivider { background:transparent; }"
        "triscord--SplitAudioButton[groupHover=\"true\"] QPushButton { background:#3c3d44; }"
        "triscord--SplitAudioButton QPushButton:hover, QPushButton#userMuteOptionsButton[open=\"true\"], QPushButton#userDeafenOptionsButton[open=\"true\"] { background:#242426; }"
        "triscord--SplitAudioButton[active=\"true\"] QPushButton { background:#47343c; }"
        "triscord--SplitAudioButton[active=\"true\"] QPushButton:hover { background:#58343b; }"
        "QPushButton#userSettingsButton { background:transparent; border:0; border-radius:8px; padding:0; }"
        "QPushButton#userSettingsButton:hover { background:#3e3f45; }"
        "QPushButton#leaveCallButton { background:#da373c; border:1px solid #da373c; border-radius:6px; color:#dcdcdf; font-weight:600; padding:6px 14px; }"
        "QPushButton#leaveCallButton:hover { background:#a1282c; border-color:#a1282c; }"
        "QPushButton#leaveCallButton:pressed { background:#8f2024; border-color:#8f2024; }"
        "QPushButton#chatAttachButton { background:#2b2d31; border:0; border-radius:12px; color:#96979e; font-size:14px; font-weight:bold; padding:0; }"
        "QPushButton#chatAttachButton:hover { background:#35373c; color:#dcdcdf; }"
        "QPushButton#chatAttachButton:disabled { background:#1e1f22; border:1px solid #282828; color:#4d505b; }"
        "QPushButton#chatSendButton { background:#5865f2; border:1px solid #5865f2; border-radius:4px; color:#dcdcdf; font-weight:600; padding:6px 14px; }"
        "QPushButton#chatSendButton:hover { background:#4752c4; }"
        "QPushButton#chatSendButton:disabled { background:#3c4270; border-color:#3c4270; color:#888888; }"
        // Observed composer: 58px box, radius 8, 1px border (black-theme colours), 16px text.
        "QWidget#channelTextArea { background:#0a0a0c; border:1px solid #48484d; border-radius:8px; margin:0; min-height:56px; }"
        "QPlainTextEdit#chatComposer { background:transparent; border:0; font-size:16px; color:#d4d5d8; }"
        "QWidget#channelTextArea QLineEdit { background:transparent; border:0; padding:4px 6px; }"
        "QWidget#channelTextArea QLineEdit:focus { border:0; }"
        "QScrollArea { border:0; }"
        "QSplitter::handle { background:#000000; }"
        "QSplitter#roomColumns::handle { background:#000000; }"
        "QSplitter::handle:hover { background:#5865f2; }"
        "QMenu { background:#121214; border:1px solid #4c4c51; border-radius:6px; padding:6px; }"
        "QMenu::item { padding:8px 18px; border-radius:4px; color:#d4d5d8; }"
        "QMenu::item:selected { background:#5865f2; color:#dcdcdf; }");
    connect(&signaling_, &Signaling::statusChanged, this, [this](const QString& message) {
        if (message.startsWith("Não foi possível") || message.startsWith("Conexão expirou")) showNotice(message);
    });
    connect(&signaling_, &Signaling::connected, this, [this] {
        status_->hide(); updateUserProfile(); showCenterState();
        if (!rejoinRoomId_.isEmpty()) {
            const auto id = std::exchange(rejoinRoomId_, QString()), name = std::exchange(rejoinRoomName_, QString());
            QTimer::singleShot(0, this, [this, id, name] { joinRoom(id, name); });
        }
    });
    connect(&signaling_, &Signaling::protocolError, this, [this](const QString& message) {
        showNotice(message.startsWith("Código do grupo") ? message : "não foi possível conectar. confira a internet e tente novamente.");
    });
    connect(&signaling_, &Signaling::eventReceived, this, &MainWindow::receiveEvent);
    connect(&signaling_, &Signaling::disconnected, this, [this] {
        if (!roomId_.isEmpty()) {
            rejoinRoomId_ = roomId_;
            rejoinRoomName_ = channelHeaderTitle_ ? channelHeaderTitle_->text() : QString();
            if (auto* camera = findChild<QPushButton*>("cameraButton")) rejoinCamera_ = camera->isChecked();
            if (auto* shareSession = findChild<ShareSession*>(); shareSession && shareSession->isSharing()) {
                rejoinShare_ = true;
                rejoinShareSource_ = shareSession->sharedSource();
                rejoinShareAudio_ = shareSession->sharedAudio();
                rejoinShareConfig_ = shareSession->sharedConfig();
            }
            showNotice("Você foi desconectado(a)... Segura firme, vamos te jogar de volta!");
        }
        shortcuts_->setActive(false);
        clearParticipantControls();
        screen_.stop();
        camera_.leave();
        soundboard_->stop(); soundboard_->hide(); sounds_->setEnabled(false);
        participantCards_->setParticipants({}); findChild<QScrollArea*>("callCardsScroll")->hide();
        roomId_.clear(); roomDirectory_ = {}; rooms_->clear(); members_->clear(); chat_->clear(); showCenterState();
        memberCount_->setText("ONLINE — 0"); leaveRoomButton_->hide();
        if (callControlsDock_) callControlsDock_->hide();
        if (voiceConnectionBar_) voiceConnectionBar_->hide();
        if (channelHeaderTitle_) channelHeaderTitle_->setText("Geral");
        if (message_) message_->setPlaceholderText("Conversar em Geral");
        serverMuted_ = false;
        owner_ = false;
        refreshAudioControls();
        updateUserProfile();
    });
    connect(rooms_, &QListWidget::itemClicked, this, [this](QListWidgetItem* item) {
        joinRoom(item->data(Qt::UserRole).toString());
    });
    auto sendMessage = [this] {
        const auto text = message_->text().trimmed();
        if (!roomId_.isEmpty() && !text.isEmpty() && signaling_.sendEvent("send-chat-message", {{"roomId", roomId_}, {"message", text}})) {
            message_->clear();
            
        }
    };
    connect(message_, &ChannelComposer::returnPressed, this, sendMessage);
    voice_.setDevices(QByteArray::fromHex(inputPreference_.toLatin1()), QByteArray::fromHex(outputPreference_.toLatin1()));
    screen_.setAudioOutput(QByteArray::fromHex(outputPreference_.toLatin1()));
    soundboard_->setOutput(QByteArray::fromHex(outputPreference_.toLatin1()));
    QTimer::singleShot(0, this, &MainWindow::startConnection);
}

void MainWindow::openEditProfileDialog() {
    if (!authSession_.isValid()) {
        // Not signed in with a triscord account (no session to edit against):
        // fall back to the plain local username, as before.
        bool ok = false;
        const auto newName = QInputDialog::getText(this, "Editar Perfil", "Nome de usuário:", QLineEdit::Normal, username_, &ok).trimmed().left(32);
        if (ok && !newName.isEmpty() && newName != username_) {
            username_ = newName;
            QSettings().setValue("username", username_);
            updateUserProfile();
            if (signaling_.ready() && !roomId_.isEmpty()) signaling_.sendEvent("user-state-change", {{"username", username_}});
        }
        return;
    }
    const bool saved = openProfileEditDialog(this, authSession_);
    authSession_.validateAsync(); // picks up an avatar uploaded or removed in the editor (GET /me)
    if (saved) {
        if (!authSession_.nick().isEmpty()) username_ = authSession_.nick();
        updateUserProfile();
        if (signaling_.ready() && !roomId_.isEmpty()) signaling_.sendEvent("user-state-change", {{"username", username_}});
    }
}

void MainWindow::updateUserProfile() {
    if (!userNameLabel_ || !userAvatarLabel_) return;
    const auto name = username_.isEmpty() ? "Usuário" : username_;
    userNameLabel_->setText(name);
    if (auto* session = findChild<ShareSession*>()) session->setLocalName(username_);
    const bool online = signaling_.ready();
    if (userTagLabel_) userTagLabel_->setText(online ? "@online" : "@offline");
    QPixmap image(32, 32);
    image.fill(Qt::transparent);
    QPainter painter(&image);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setRenderHint(QPainter::SmoothPixmapTransform);
    painter.setPen(Qt::NoPen);
    // Account avatar (uploaded or Google): the first frame only, so an animated GIF never keeps the idle
    // app repainting. The letter tile stays while the image downloads or when there is none.
    QPixmap photo;
    const auto avatarUrl = authSession_.isValid() ? authSession_.avatarUrl() : QString();
    if (!avatarUrl.isEmpty()) {
        auto& images = RemoteImageCache::instance();
        const auto bytes = images.bytes(avatarUrl);
        if (bytes.isEmpty()) images.fetch(avatarUrl);
        else photo.loadFromData(bytes); // QPixmap decodes a GIF's first frame
    }
    if (!photo.isNull()) {
        QPainterPath circle; circle.addEllipse(0, 0, 32, 32);
        painter.setClipPath(circle);
        painter.drawPixmap(0, 0, photo.scaled(32, 32, Qt::KeepAspectRatioByExpanding, Qt::SmoothTransformation));
        painter.setClipping(false);
    } else {
        painter.setBrush(QColor("#5865f2"));
        painter.drawEllipse(0, 0, 32, 32);
        painter.setPen(Qt::white);
        painter.setFont(QFont("gg sans", 12, QFont::Bold));
        painter.drawText(image.rect(), Qt::AlignCenter, name.left(1).toUpper());
    }
    // Observed: the settings profile header shows the avatar without the status indicator.
    painter.end();
    if (settingsProfileAvatar_) settingsProfileAvatar_->setPixmap(image.scaled(48, 48, Qt::KeepAspectRatio, Qt::SmoothTransformation));
    painter.begin(&image); painter.setRenderHint(QPainter::Antialiasing);
    painter.setBrush(QColor(online ? "#23a55a" : "#81828a"));
    painter.setPen(QPen(QColor("#000000"), 2));
    painter.drawEllipse(20, 20, 10, 10);
    painter.end();
    userAvatarLabel_->setPixmap(image);
}

void MainWindow::showNotice(const QString& message) {
    status_->setText(message);
    status_->show();
    noticeTimer_.start(10000);
}

void MainWindow::startConnection() {
    if (username_.size() >= 2) {
        updateUserProfile();
        if (currentServer_.id.isEmpty()) {
            signaling_.connectTo(QUrl(serverUrl_.trimmed()), groupInvite_.trimmed());
        } else {
            // Hub routing contract: serverId selects the server's Durable Object and sessionToken proves
            // membership; neither the group invite nor a client-chosen name is trusted there.
            signaling_.connectTo(QUrl(serverUrl_.trimmed()), {},
                {{"serverId", currentServer_.id}, {"sessionToken", authSession_.session()}});
        }
        return;
    }
    auto* dialog = new QDialog(this);
    dialog->setObjectName("welcomeDialog");
    dialog->setWindowTitle("Bem-vindo ao Triscord");
    dialog->setModal(true);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    auto* layout = new QVBoxLayout(dialog);
    layout->setContentsMargins(24, 24, 24, 24);
    layout->addWidget(new QLabel("Como você quer ser chamado?", dialog));
    auto* name = new QLineEdit(dialog);
    name->setObjectName("firstNameInput");
    name->setPlaceholderText("Seu nome");
    name->setMaxLength(32);
    layout->addWidget(name);
    auto* notice = new QLabel("Use pelo menos dois caracteres.", dialog);
    layout->addWidget(notice);
    auto* enter = new QPushButton("Continuar", dialog);
    enter->setObjectName("continueButton");
    enter->setEnabled(false);
    enter->setDefault(true);
    layout->addWidget(enter);
    connect(name, &QLineEdit::textChanged, enter, [enter](const QString& text) {
        enter->setEnabled(text.trimmed().size() >= 2);
    });
    connect(enter, &QPushButton::clicked, dialog, &QDialog::accept);
    connect(dialog, &QDialog::accepted, this, [this, name] {
        username_ = name->text().trimmed();
        QSettings().setValue("username", username_);
        updateUserProfile();
        startConnection();
    });
    connect(dialog, &QDialog::rejected, this, &QWidget::close);
    dialog->show();
    name->setFocus();
}

MainWindow::~MainWindow() {
    shortcuts_->setActive(false);
    if (auto* view = findChild<CameraView*>(); view && view->isVisible()) view->reject();
    // Close signaling while the media services still exist. Socket destruction
    // can emit disconnected synchronously, after C++ member destruction begins.
    QObject::disconnect(&signaling_, nullptr, this, nullptr);
    signaling_.disconnectFromServer();
}
void MainWindow::updateRooms(const QJsonArray& rooms) {
    roomDirectory_ = rooms;
    QSignalBlocker blocker(rooms_);
    // Keep items alive across presence updates; no full rebuild of the directory.
    for (int i = 0; i < rooms.size(); ++i) {
        const auto room = rooms.at(i).toObject();
        const auto id = room.value("id").toString();
        const auto roomName = room.value("name").toString();
        QListWidgetItem* item = nullptr;
        if (i < rooms_->count() && rooms_->item(i)->data(Qt::UserRole).toString() == id) item = rooms_->item(i);
        for (int j = i + 1; !item && j < rooms_->count(); ++j) {
            if (rooms_->item(j)->data(Qt::UserRole).toString() == id) {
                item = rooms_->takeItem(j); break;
            }
        }
        if (!item) item = new QListWidgetItem;
        if (rooms_->row(item) != i) rooms_->insertItem(i, item);
        item->setData(Qt::UserRole, id);
        // Discord shows no count next to a voice channel; occupancy stays available to assistive tech.
        item->setData(ChannelRowDelegate::IconRole, static_cast<int>(DiscordIcons::IconType::VoiceSpeaker));
        item->setText(roomName);
        item->setData(ChannelRowDelegate::VoiceUsersRole, room.value("users").toArray());
        item->setData(ChannelRowDelegate::ConnectedRole, id == roomId_);
        item->setData(Qt::AccessibleTextRole, QString("%1, %2 na sala").arg(roomName).arg(room.value("userCount").toInt()));
        if (id == roomId_) {
            owner_ = room.value("ownerUserId").toString() == userId_;
            rooms_->setCurrentItem(item);
            if (channelHeaderTitle_) channelHeaderTitle_->setText(roomName);
            if (chatPanelTitle_) chatPanelTitle_->setText(roomName);
            if (message_) message_->setPlaceholderText(QString("Conversar em %1").arg(roomName));
            if (voiceConnectionRoom_) voiceConnectionRoom_->setText(roomName + " / " + (currentServer_.name.isEmpty() ? QString("Triscord") : currentServer_.name));
            const auto users = room.value("users").toArray();
            participantCards_->setLocalId(signaling_.socketId());
            participantCards_->setParticipants(users);
                disconnect(participantCards_, &ParticipantPane::participantContextMenuRequested, this, nullptr);
                connect(participantCards_, &ParticipantPane::participantContextMenuRequested, this, [this](const QString& id, const QString& name, const QPoint& pos) {
                    if (id != signaling_.socketId() || (owner_ && serverMuted_)) showUserContextMenu(id, name, pos);
                });
            findChild<QScrollArea*>("callCardsScroll")->setVisible(!users.isEmpty());
            memberCount_->setText(QString("ONLINE — %1").arg(users.size()));
            for (int n = 0; n < users.size(); ++n) {
                const auto obj = users[n].toObject(); const auto socket = obj.value("socketId").toString();
                if (obj.value("isServerMuted").toBool()) roomMutedPeers_.insert(socket); else roomMutedPeers_.remove(socket);
                QListWidgetItem* member = n < members_->count() && members_->item(n)->data(Qt::UserRole).toString() == socket ? members_->item(n) : nullptr;
                for (int j = n + 1; !member && j < members_->count(); ++j)
                    if (members_->item(j)->data(Qt::UserRole).toString() == socket) member = members_->takeItem(j);
                if (!member) member = new QListWidgetItem;
                if (members_->row(member) != n) members_->insertItem(n, member);
                member->setData(Qt::UserRole, socket);
                const auto name = obj.value("username").toString();
                const auto avatar = obj.value("avatar").toString();
                const auto visualKey = name + avatar;
                if (member->data(Qt::UserRole + 1).toString() != visualKey) {
                    QPixmap image(32, 32); image.fill(Qt::transparent);
                    QPainter painter(&image); painter.setRenderHint(QPainter::Antialiasing);
                    QColor color(avatar); if (!color.isValid()) color = QColor("#5865f2");
                    painter.setPen(Qt::NoPen); painter.setBrush(color); painter.drawEllipse(0, 0, 32, 32);
                    painter.setPen(Qt::white); painter.setFont(QFont("gg sans", 12, QFont::Bold));
                    painter.drawText(image.rect(), Qt::AlignCenter, name.left(1).toUpper());
                    painter.setBrush(QColor("#23a55a"));
                    painter.setPen(QPen(QColor("#000000"), 2));
                    painter.drawEllipse(20, 20, 10, 10);
                    painter.end();
                    member->setIcon(QIcon(image)); member->setData(Qt::UserRole + 1, visualKey);
                }
                QString state = obj.value("isDeafened").toBool() ? "Áudio desativado" : obj.value("isMuted").toBool() ? "Microfone desativado" : "na chamada";
                if (!obj.value("authenticated").toBool(false)) state += " · não verificado";  // fail closed: absent means unknown, not verified
                member->setTextAlignment(Qt::AlignLeft | Qt::AlignVCenter);
                member->setText(name + "\n" + state); member->setToolTip(obj.value("status").toString());
            }
            members_->setIconSize({32, 32});
            while (members_->count() > users.size()) delete members_->takeItem(members_->count() - 1);
        }
    }
    while (rooms_->count() > rooms.size()) delete rooms_->takeItem(rooms_->count() - 1);
    rooms_->doItemsLayout(); // participant rows change each channel's height
    showCenterState();
}

void MainWindow::updateFocusHeader() {
    if (!focusTitle_) return;
    const auto info = roomId_.isEmpty() ? ParticipantPane::FocusInfo{} : participantCards_->focusInfo();
    const bool show = !info.title.isEmpty(), stream = show && info.stream;
    for (auto* w : {static_cast<QWidget*>(focusSeparator_), static_cast<QWidget*>(focusAvatar_), static_cast<QWidget*>(focusTitle_)}) w->setVisible(show);
    qualityPill_->setVisible(stream && !info.quality.isEmpty());
    livePill_->setVisible(stream);
    if (!show) return;
    if (focusTitle_->text() != info.title) focusTitle_->setText(info.title);
    if (qualityPill_->text() != info.quality) qualityPill_->setText(info.quality);
    const QString avatarKey = info.owner + info.color.name();
    if (focusAvatar_->property("avatarKey").toString() != avatarKey) {
        focusAvatar_->setProperty("avatarKey", avatarKey);
        QPixmap image(24, 24); image.fill(Qt::transparent);
        QPainter painter(&image); painter.setRenderHint(QPainter::Antialiasing);
        painter.setPen(Qt::NoPen); painter.setBrush(info.color); painter.drawEllipse(0, 0, 24, 24);
        painter.setPen(Qt::white); QFont letter = font(); letter.setPixelSize(11); letter.setBold(true); painter.setFont(letter);
        painter.drawText(QRect(0, 0, 24, 24), Qt::AlignCenter, info.owner.left(1).toUpper());
        painter.end(); focusAvatar_->setPixmap(image);
    }
}

void MainWindow::appendMessage(const QJsonObject& message) {
    chat_->appendMessage(message);
}
void MainWindow::joinRoom(const QString& id, const QString& name) {
    if (!signaling_.ready()) { showNotice("Aguardando conexão para entrar na sala."); return; }
    if (id == roomId_) return;
    screen_.stop(); camera_.leave();
    if (channelHeaderTitle_ && !name.isEmpty()) channelHeaderTitle_->setText(name);
    if (message_ && !name.isEmpty()) message_->setPlaceholderText(QString("Conversar em %1").arg(name));
    if (voiceConnectionRoom_ && !name.isEmpty()) voiceConnectionRoom_->setText(name + " / " + (currentServer_.name.isEmpty() ? QString("Triscord") : currentServer_.name));
    // sessionToken: authoritative identity for signed-in users. The server
    // derives the display name from the session and ignores the client-sent
    // "username" when a valid token is present; it is sent anyway so a
    // signed-out client still behaves as before.
    signaling_.sendEvent("join-room", {{"roomId", id}, {"roomName", name},
        {"userData", QJsonObject{{"userId", userId_}, {"username", username_}, {"sessionToken", authSession_.session()},
                                 {"avatar", "#5865f2"}, {"isMuted", serverMuted_ || microphoneMuted(mute_->isChecked(), pushToTalk_, talkHeld_)},
                                 {"isDeafened", deafen_->isChecked()}, {"appVersion", "native-preview-0.9.21"}}}});
}

void MainWindow::signInWithGoogle() {
    auto* flow = new GoogleAuthFlow(this);
    connect(flow, &GoogleAuthFlow::succeeded, this, [this, flow](const GoogleIdentity& identity) {
        flow->deleteLater();
        auto nick = identity.nick;
        if (identity.isNew) {
            const auto suggested = identity.email.section('@', 0, 0).left(32);
            nick = chooseNickDialog(this, identity.session, nick.isEmpty() ? suggested : nick);
            if (nick.isEmpty()) nick = suggested; // user cancelled the dialog but is already signed in.
        }
        authSession_.setSignedIn(identity.session, identity.id, identity.email, nick, identity.avatarUrl,
                                  QDateTime::fromString(identity.expiresAt, Qt::ISODate));
        showNotice(QString("Conectado com a conta Google (%1).").arg(identity.email));
    });
    connect(flow, &GoogleAuthFlow::failed, this, [this, flow](const QString& reason) {
        flow->deleteLater();
        if (reason == "missing-client-secret") {
            showNotice("Login com Google indisponível: configuração ausente (TRISCORD_GOOGLE_CLIENT_SECRET).");
        } else if (reason != "cancelled") {
            showNotice("Não foi possível entrar com o Google. Tente novamente.");
        }
    });
    flow->start();
}

void MainWindow::signOutOfGoogle() {
    authSession_.clearSession();
    showNotice("Sessão do Google encerrada.");
    emit loggedOut();
}
void MainWindow::leaveRoom() {
    rejoinRoomId_.clear(); rejoinRoomName_.clear(); rejoinCamera_ = false; rejoinShare_ = false;
    serverMuted_ = false;
    shortcuts_->setActive(false);
    clearParticipantControls();
    soundboard_->stop(); soundboard_->hide(); sounds_->setEnabled(false);
    participantCards_->setParticipants({}); findChild<QScrollArea*>("callCardsScroll")->hide();
    screen_.leave(); voice_.leave(); camera_.leave();
    if (!roomId_.isEmpty()) signaling_.sendEvent("leave-room", {});
    roomId_.clear(); owner_ = false; members_->clear(); chat_->clear(); speakingPeers_.clear();
    memberCount_->setText("ONLINE — 0"); leaveRoomButton_->hide();
    if (callControlsDock_) callControlsDock_->hide();
    if (voiceConnectionBar_) voiceConnectionBar_->hide();
    if (message_) message_->setPlaceholderText("Conversar em Geral");
    if (rooms_) rooms_->setCurrentItem(nullptr);
    for (int n = 0; rooms_ && n < rooms_->count(); ++n) rooms_->item(n)->setData(ChannelRowDelegate::ConnectedRole, rooms_->item(n)->data(Qt::UserRole).toString() == roomId_ && !roomId_.isEmpty());
    refreshAudioControls();
    message_->setAccessibleName("mensagem");
    if (chatPanel_) chatPanel_->hide();
    unreadChatCount_ = 0;
    if (chatUnreadBadge_) chatUnreadBadge_->setCount(0);
    showCenterState();
}

void MainWindow::updateCallChrome() {
    // Observed in the connected call view: header title and control bar appear only while the pointer is
    // over the call area. Outside a call (pre-join view) the header stays visible.
    const bool inRoom = !roomId_.isEmpty();
    const bool show = !inRoom || centerHovered_;
    for (int i = 0; i < callChrome_.size(); ++i) callChrome_[i]->setVisible(i < 2 ? show : (inRoom && centerHovered_));
    // Before joining, triscord has no channel chat to show, so the toggle only exists inside a call.
    if (chatToggle_) chatToggle_->setVisible(inRoom && centerHovered_ && chatPanel_ && chatPanel_->isHidden());
}

void MainWindow::showCenterState() {
    if (!centerStack_) return;
    const bool inRoom = !roomId_.isEmpty();
    QJsonObject viewed;
    for (const auto& value : roomDirectory_)
        if (value.toObject().value("id").toString() == viewedRoomId_) viewed = value.toObject();
    if (!inRoom && viewed.isEmpty() && !roomDirectory_.isEmpty()) {
        viewed = roomDirectory_.first().toObject();
        viewedRoomId_ = viewed.value("id").toString();
    }
    if (!inRoom) {
        const auto name = viewed.isEmpty() ? channelHeaderTitle_->text() : viewed.value("name").toString();
        channelHeaderTitle_->setText(name);
        prejoin_->setChannel(name, viewed.isEmpty() ? -1 : viewed.value("userCount").toInt());
        prejoin_->joinButton()->setEnabled(signaling_.ready() && !viewed.isEmpty());
    }
    centerStack_->setCurrentWidget(inRoom ? centerBody_ : static_cast<QWidget*>(prejoin_));
    updateCallChrome();
    // Observed card heights: 58px alone, 159px with the 101px "Voz conectada" section.
    if (accountCard_ && voiceConnectionBar_) {
        const auto* stream = accountCard_->findChild<QWidget*>("voiceStreamSection");
        accountCard_->setFixedHeight(voiceConnectionBar_->isHidden() ? 58 : 159 + (stream && !stream->isHidden() ? 57 : 0));
    }
    // Observed: neither the pre-join view nor the call view of a voice channel shows a member list.
    if (auto* people = findChild<QWidget*>("peoplePanel")) people->hide();
    // Observed: the pre-join view has neither the header divider nor the column top border.
    for (QWidget* w : {channelHeader_, channelHeader_->parentWidget()}) {
        w->setProperty("prejoin", !inRoom);
        w->setProperty("voiceCall", inRoom);
        w->style()->unpolish(w); w->style()->polish(w);
    }
    // The centre surface follows the observed views: gradient before joining, black stage in a call.
    if (auto* column = findChild<QWidget*>("centerColumn")) {
        column->setProperty("prejoin", !inRoom); column->setProperty("voiceCall", inRoom);
        column->style()->unpolish(column); column->style()->polish(column);
    }
    if (centerSurface_) static_cast<CenterSurface*>(centerSurface_)->setMode(inRoom ? CenterSurface::Mode::Call : CenterSurface::Mode::Prejoin);
}


void MainWindow::receiveEvent(const QString& event, const QJsonArray& args) {
    if (args.isEmpty()) return;
    const auto data = args.first();
    if (event == "rooms-update" && data.isArray()) updateRooms(data.toArray());
    else if (event == "room-joined") {
        clearParticipantControls();
        const auto obj = data.toObject();
        serverMuted_ = obj.value("isServerMuted").toBool();
        roomId_ = obj.value("roomId").toString(); viewedRoomId_ = roomId_; leaveRoomButton_->show();
        if (callControlsDock_) callControlsDock_->show();
        if (voiceConnectionBar_) voiceConnectionBar_->show();
        soundboard_->stop(); sounds_->setEnabled(true);
        if (std::exchange(rejoinCamera_, false)) QTimer::singleShot(800, this, [this] { // the camera service enables its button once the room is ready
            if (auto* camera = findChild<QPushButton*>("cameraButton")) if (camera->isEnabled() && !camera->isChecked() && !roomId_.isEmpty()) camera->click();
        });
        if (std::exchange(rejoinShare_, false)) {
            const auto source = rejoinShareSource_; const auto audio = rejoinShareAudio_; const auto config = rejoinShareConfig_;
            QTimer::singleShot(800, this, [this, source, audio, config] { // the screen service enables its button on the same schedule as the camera
                if (auto* shareSession = findChild<ShareSession*>(); shareSession && !shareSession->isSharing() && !roomId_.isEmpty())
                    shareSession->resumeShare(source, audio, config);
            });
        }
        for (int n = 0; rooms_ && n < rooms_->count(); ++n) rooms_->item(n)->setData(ChannelRowDelegate::ConnectedRole, rooms_->item(n)->data(Qt::UserRole).toString() == roomId_ && !roomId_.isEmpty());
        chat_->clear();
        for (const auto& msg : obj.value("chatHistory").toArray()) appendMessage(msg.toObject());
        
        refreshAudioControls();
        status_->hide();
        updateRooms(roomDirectory_);
    } else if (event == "user-left") {
        const auto id = data.toObject().value("socketId").toString();
        peerVolumePercent_.remove(id); peerPanPercent_.remove(id); localMutedPeers_.remove(id);
        streamVolumePercent_.remove(id); streamMutedPeers_.remove(id); speakingPeers_.remove(id);
        disabledVideoPeers_.remove(id); findChild<ShareSession*>()->setPeerVideoDisabled(id, false);
    } else if (event == "user-joined" && !roomId_.isEmpty()) {
        notifications_->memberEntered(data.toObject().value("userData").toObject().value("username").toString(), QApplication::applicationState() != Qt::ApplicationActive);
    } else if (event == "new-chat-message") {
        appendMessage(data.toObject());
        if (!roomId_.isEmpty()) notifications_->chatMessage(data.toObject(), signaling_.socketId(), username_, QApplication::applicationState() != Qt::ApplicationActive);
        if (chatPanel_ && chatPanel_->isHidden() && data.toObject().value("senderSocketId").toString() != signaling_.socketId()) {
            ++unreadChatCount_;
            if (chatUnreadBadge_) chatUnreadBadge_->setCount(unreadChatCount_);
        }
    }
    else if (event == "soundboard-played" && !roomId_.isEmpty() && data.toObject().value("roomId").toString() == roomId_) soundboard_->play(data.toObject().value("soundId").toString());
    else if (event == "message-reaction-updated" && data.toObject().value("roomId").toString() == roomId_) chat_->updateReactions(data.toObject());
    else if (event == "chat-message-deleted" && data.toObject().value("roomId").toString() == roomId_) chat_->removeMessage(data.toObject().value("messageId").toString());
    else if (event == "request-error") showNotice(data.toObject().value("message").toString());
    else if (event == "room-join-denied") { rejoinCamera_ = false; rejoinShare_ = false; showNotice("sala bloqueada ou cheia"); }
    else if (event == "kicked" || event == "session-replaced") {
        leaveRoom(); showNotice("você saiu da sala");
    } else if (event == "force-muted") {
        serverMuted_ = data.toObject().value("muted").toBool(true);
        if (serverMuted_) roomMutedPeers_.insert(signaling_.socketId()); else roomMutedPeers_.remove(signaling_.socketId());
        mute_->setChecked(true);
        refreshAudioControls();
        applyMicrophoneState();
        if (serverMuted_) showNotice("o dono da sala silenciou seu microfone");
    } else if (event == "chat-rate-limited") showNotice("aguarde antes de enviar outra mensagem");
    else if (event == "service-limit") showNotice("limite gratuito do serviço atingido. tente novamente no próximo dia utc.");
}

void MainWindow::applyMicrophoneState() {
    if (!mute_) return;
    const bool muted = serverMuted_ || microphoneMuted(mute_->isChecked(), pushToTalk_, talkHeld_);
    if (effectiveMuted_ == muted) return;
    effectiveMuted_ = muted; voice_.setMuted(muted);
    if (!roomId_.isEmpty()) signaling_.sendEvent("user-state-change", {{"isMuted", muted}});
}
void MainWindow::setSelfDeafened(bool deafened) {
    voice_.setDeafened(deafened);
    screen_.setDeafened(deafened);
    soundboard_->setDeafened(deafened);
    if (!roomId_.isEmpty()) signaling_.sendEvent("user-state-change", {{"isDeafened", deafened}});
}
void MainWindow::refreshAudioControls() {
    if (!mute_ || !deafen_ || !micGroup_ || !deafenGroup_) return;
    // Observed states and tooltips: "Silenciar"/"Dessilenciar", "Desativar áudio"/"Reativar áudio";
    // the controls stay usable outside a call. Server mute is a triscord room rule.
    const bool muted = mute_->isChecked(), deafened = deafen_->isChecked();
    mute_->setEnabled(!serverMuted_);
    deafen_->setEnabled(true);
    micGroup_->setActive(muted);
    deafenGroup_->setActive(deafened);
    using Icon = DiscordIcons::IconType;
    const QColor danger("#da3e44"), normal("#96979e"), hover("#efefef");
    setHoverIcons(mute_, DiscordIcons::icon(muted ? Icon::MicrophoneMuted : Icon::Microphone, muted ? danger : normal, 20),
                  DiscordIcons::icon(muted ? Icon::MicrophoneMuted : Icon::Microphone, muted ? danger : hover, 20));
    setHoverIcons(deafen_, DiscordIcons::icon(deafened ? Icon::HeadphonesDeafened : Icon::Headphones, deafened ? danger : normal, 20),
                  DiscordIcons::icon(deafened ? Icon::HeadphonesDeafened : Icon::Headphones, deafened ? danger : hover, 20));
    mute_->setToolTip(serverMuted_ ? "microfone silenciado pelo dono da sala" : muted ? "Dessilenciar" : "Silenciar");
    if (barMicGroup_) {
        barMicGroup_->setActive(muted);
        barMicGroup_->toggle()->setEnabled(!serverMuted_);
        barMicGroup_->toggle()->setToolTip(mute_->toolTip());
        setHoverIcons(barMicGroup_->toggle(), DiscordIcons::icon(muted ? Icon::MicrophoneMuted : Icon::Microphone, muted ? danger : QColor("#dcdcdf"), 20),
                      DiscordIcons::icon(muted ? Icon::MicrophoneMuted : Icon::Microphone, muted ? danger : QColor("#dcdcdf"), 20));
    }
    // Observed: soundboard is unavailable while deafened, with this tooltip.
    const bool soundsAvailable = !roomId_.isEmpty() && !deafened;
    for (auto* button : {sounds_, rtcSounds_}) if (button) {
        button->setEnabled(soundsAvailable);
        button->setToolTip(deafened ? "Os efeitos sonoros são desativados quando o áudio é desativado" : "Painel de Sons");
    }
    deafen_->setToolTip(deafened ? "Reativar áudio" : "Desativar áudio");
}
void MainWindow::clearParticipantControls() {
    talkHeld_ = false;
    peerVolumePercent_.clear(); peerPanPercent_.clear(); localMutedPeers_.clear();
    streamVolumePercent_.clear(); streamMutedPeers_.clear(); disabledVideoPeers_.clear(); speakingPeers_.clear();
    roomMutedPeers_.clear();
}
void MainWindow::showUserContextMenu(const QString& id, const QString& name, const QPoint& globalPos) {
    using Trailing = DiscordMenuTrailing;
    if (id == signaling_.socketId() && owner_ && serverMuted_) {
        auto* menu = createDiscordMenu(this); menu->setAttribute(Qt::WA_DeleteOnClose);
        auto* release = addDiscordMenuRow(menu, "Silenciar voz no servidor", std::nullopt, Trailing::Checkbox, true, true);
        connect(release, &QAction::triggered, this, [this, id] { signaling_.sendEvent("force-mute-user", {{"socketId", id}, {"muted", false}}); });
        menu->popup(globalPos);
        return;
    }
    // Surface, row geometry, checkboxes and danger rows follow the observed Discord menus (CALLS.md); the set of
    // rows is limited to what triscord can do, and the sliders reuse the observed volume block of the audio menu.
    auto* menu = createDiscordMenu(this);
    menu->setObjectName("userContextMenu");
    menu->setAttribute(Qt::WA_DeleteOnClose);

    addDiscordMenuSlider(menu, "Volume do usuário", 0, 200, peerVolumePercent_.value(id, 100), "peerAudioVolume", [this, id](int value) {
        peerVolumePercent_[id] = value; voice_.setPeerVolume(id, value / 100.0f);
    });
    addDiscordMenuSlider(menu, "Posição do áudio", -100, 100, peerPanPercent_.value(id, 0), "peerAudioPan", [this, id](int value) {
        peerPanPercent_[id] = value; voice_.setPeerPan(id, value / 100.f);
    });
    menu->addSeparator();
    auto* mute = addDiscordMenuRow(menu, "Silenciar", std::nullopt, Trailing::Checkbox, localMutedPeers_.contains(id));
    connect(mute, &QAction::triggered, this, [this, id] {
        const bool muted = !localMutedPeers_.contains(id);
        if (muted) localMutedPeers_.insert(id); else localMutedPeers_.remove(id);
        voice_.setPeerMuted(id, muted);
    });
    auto* disableVideo = addDiscordMenuRow(menu, "Desativar vídeo", std::nullopt, Trailing::Checkbox, disabledVideoPeers_.contains(id));
    connect(disableVideo, &QAction::triggered, this, [this, id] {
        const bool disabled = !disabledVideoPeers_.contains(id);
        if (disabled) disabledVideoPeers_.insert(id); else disabledVideoPeers_.remove(id);
        findChild<ShareSession*>()->setPeerVideoDisabled(id, disabled);
    });
    menu->addSeparator();
    addDiscordMenuSlider(menu, "Volume da transmissão", 0, 200, streamVolumePercent_.value(id, 100), "streamAudioVolume", [this, id](int value) {
        streamVolumePercent_[id] = value; screen_.setStreamVolume(id, value / 100.f);
    });
    auto* streamMute = addDiscordMenuRow(menu, "Silenciar transmissão", std::nullopt, Trailing::Checkbox, streamMutedPeers_.contains(id));
    connect(streamMute, &QAction::triggered, this, [this, id] {
        const bool muted = !streamMutedPeers_.contains(id);
        if (muted) streamMutedPeers_.insert(id); else streamMutedPeers_.remove(id);
        screen_.setStreamMuted(id, muted);
    });
    menu->addSeparator();
    auto* mention = addDiscordMenuRow(menu, "Mencionar");
    connect(mention, &QAction::triggered, this, [this, name] {
        message_->setText(QString("@%1 ").arg(name) + message_->text()); message_->setFocus();
    });
    auto* copyName = addDiscordMenuRow(menu, "Copiar nome");
    connect(copyName, &QAction::triggered, this, [name] { QGuiApplication::clipboard()->setText(name); });

    if (owner_) {
        menu->addSeparator();
        auto* serverMute = addDiscordMenuRow(menu, "Silenciar voz na sala", std::nullopt, Trailing::Checkbox, roomMutedPeers_.contains(id), true);
        connect(serverMute, &QAction::triggered, this, [this, id] {
            signaling_.sendEvent("force-mute-user", {{"socketId", id}, {"muted", !roomMutedPeers_.contains(id)}});
        });
        auto* kick = addDiscordMenuRow(menu, "Expulsar da sala", std::nullopt, Trailing::None, false, true);
        connect(kick, &QAction::triggered, this, [this, id] { signaling_.sendEvent("kick-user", {{"socketId", id}}); });
    }
    menu->popup(globalPos);
}
}

namespace triscord {
bool MainWindow::nativeEvent(const QByteArray& eventType, void* message, qintptr* result) {
    if (titleBar_ && handleNativeFrameMessage(this, message, result, [this](const QPoint& client) {
            return titleBar_->isCaption(titleBar_->mapFrom(this, client));
        }))
        return true;
    return QMainWindow::nativeEvent(eventType, message, result);
}
}

namespace triscord {

void MainWindow::refreshIce() {
    if (!hub_.canCall()) return;
    hub_.fetchIce([this](int status, const QJsonArray& iceServers) {
        const auto entries = parseRtcIceServers(iceServers);
        if (status != 200 || entries.empty()) return; // 404 on a hub without /ice: STUN-only, as before.
        // A cached set from the hub may be up to 300 s into its 600 s life (ICE_CACHE_MS): trust 280 s.
        setSessionIceServers(entries, QDateTime::currentMSecsSinceEpoch() + 280000);
        if (!iceRefresh_.isActive()) iceRefresh_.start();
    });
}

void MainWindow::refreshServers(const QString& selectId) {
    if (!hub_.canCall()) return;
    hub_.listServers([this, selectId](int status, const QList<HubServer>& servers) {
        if (status != 200) return; // hub without the server layer: only the legacy group exists.
        for (auto& entry : railServers_) entry.first->deleteLater();
        railServers_.clear();
        for (const auto& server : servers) {
            auto* item = serverRail_->addServer(ServerRail::acronymTile(server.name, qMax(1.0, devicePixelRatioF() * 2)), server.name);
            railServers_.append({item, server});
            connect(item, &QAbstractButton::clicked, this, [this, server] { switchServer(server); });
        }
        if (!selectId.isEmpty()) {
            for (const auto& entry : railServers_)
                if (entry.second.id == selectId) { switchServer(entry.second); return; }
        }
        // Keep the active server's metadata current (e.g. its name) without reconnecting.
        for (const auto& entry : railServers_)
            if (entry.second.id == currentServer_.id) currentServer_ = entry.second;
        applyServerChrome();
    });
}

void MainWindow::applyServerChrome() {
    const bool legacy = currentServer_.id.isEmpty();
    const auto name = legacy ? QString("Triscord") : currentServer_.name;
    if (legacyRailItem_) legacyRailItem_->setSelected(legacy);
    for (const auto& entry : railServers_) entry.first->setSelected(!legacy && entry.second.id == currentServer_.id);
    if (serverTitle_) serverTitle_->setText(name);
    if (titleBar_) titleBar_->setContext(legacy ? QPixmap(":/triscord/icon.png") : ServerRail::acronymTile(name), name);
    if (inviteButton_) inviteButton_->setVisible(!legacy && currentServer_.ownerAccountId == authSession_.id() && !authSession_.id().isEmpty());
}

void MainWindow::switchServer(const HubServer& server) {
    if (server.id == currentServer_.id) { applyServerChrome(); return; }
    if (!server.id.isEmpty() && !authSession_.isValid()) { showNotice("Entre com o Google para abrir este servidor."); return; }
    leaveRoom();
    currentServer_ = server;
    QSettings().setValue("lastServerId", server.id);
    applyServerChrome();
    signaling_.disconnectFromServer();
    startConnection();
}

void MainWindow::openServerDialog() {
    if (!hub_.canCall()) { showNotice("Entre com o Google para criar ou entrar em um servidor."); return; }
    auto* dialog = new ServerDialog(&hub_, authSession_.nick().isEmpty() ? username_ : authSession_.nick(), this);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    connect(dialog, &ServerDialog::serverReady, this, [this](const HubServer& server) { refreshServers(server.id); });
    dialog->adjustSize();
    dialog->move(geometry().center() - dialog->rect().center());
    dialog->open();
}

void MainWindow::createInvite() {
    if (currentServer_.id.isEmpty()) return;
    inviteButton_->setEnabled(false);
    hub_.createInvite(currentServer_.id, [this](int status, const QString& code) {
        inviteButton_->setEnabled(true);
        if (status != 201 || code.isEmpty()) {
            showNotice(status == 403 ? "Só quem criou o servidor pode convidar pessoas." : "Não foi possível criar o convite agora.");
            return;
        }
        QGuiApplication::clipboard()->setText(code);
        showNotice("Convite copiado. Envie o código para seu amigo e peça para ele usar \"Entrar em um servidor\".");
    });
}

} // namespace triscord
