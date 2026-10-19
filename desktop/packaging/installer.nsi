; Per-user installer of the WebView2 client ("Triscord-Setup-<version>.exe"), built by scripts/portable-web.ps1 from
; the same verified staging as the portable launcher (makensis /INPUTCHARSET UTF8). Like Discord's (Squirrel):
; no administrator and no wizard, a short progress window, then the app starts. The program goes to
; %LOCALAPPDATA%\Triscord\app, apart from the app's own data in %LOCALAPPDATA%\Triscord (WebView2 profile, caches:
; TriscordNativePreview, ...), as Discord keeps app-<version> apart from its data; uninstalling removes only "app".
; The updater (src/update_splash.*) runs it with /S /UPDATE: it waits for the app to exit, replaces the files and
; starts the new version.
Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

Name "Triscord"
Caption "Instalando o Triscord"
BrandingText "Triscord ${APP_VERSION}"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
OutFile "${OUTPUT_EXE}"
InstallDir "$LOCALAPPDATA\Triscord\app"
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails nevershow
ShowUninstDetails nevershow
SetCompressor /SOLID lzma
CRCCheck force
ManifestDPIAware true
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1046 "ProductName" "Triscord"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do Triscord"
VIAddVersionKey /LANG=1046 "CompanyName" "Triscord"
VIAddVersionKey /LANG=1046 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${APP_VERSION}"
Page instfiles
UninstPage instfiles

!ifndef UNINSTALL_KEY
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TriscordWebView2"
!endif
Var update
Var nolaunch
Var portableFrom

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "O Triscord precisa de Windows de 64 bits."
    Abort
  ${EndIf}
  SetShellVarContext current
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/PORTABLE" $1
  ${IfNot} ${Errors}
    ; An environment value preserves Unicode/spaces without NSIS command-line quoting ambiguities.
    ReadEnvStr $portableFrom "TRISCORD_PORTABLE_RUNTIME"
    ${If} $portableFrom == ""
      Abort
    ${EndIf}
    IfFileExists "$portableFrom\complete.marker" +2 0
      Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $update "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/NOLAUNCH" $1   ; tests: install without starting the app
  ${IfNot} ${Errors}
    StrCpy $nolaunch "1"
  ${EndIf}
FunctionEnd

Section
  SetOutPath "$INSTDIR"
  ; A running Triscord keeps its executable and DLLs locked. An update waits for the app that started it to exit
  ; (up to 15s); a manual install asks to close it.
  StrCpy $2 0
check:
  IfFileExists "$INSTDIR\${APP_EXE}" 0 install
  ClearErrors
  FileOpen $3 "$INSTDIR\${APP_EXE}" a
  IfErrors locked
  FileClose $3
  Goto install
locked:
  ${If} $update == "1"
    IntOp $2 $2 + 1
    ${If} $2 > 30
      SetErrorLevel 2
      Quit
    ${EndIf}
    Sleep 500
    Goto check
  ${EndIf}
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O Triscord está aberto. Feche-o e clique em Repetir para concluir a instalação." /SD IDCANCEL IDRETRY check
  SetErrorLevel 2
  Quit
install:
  ; Drop the previous version's files so nothing removed from the package lingers (user data is elsewhere).
  RMDir /r "$INSTDIR\web"
  Delete "$INSTDIR\*.old"
  ClearErrors
  File /r "${PACKAGE_DIR}\*"
  IfErrors failure
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Triscord"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Triscord"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0
  ${If} $portableFrom != ""
    ; Publish the redirect only after all installed files are in place. Keep the old runtime as fallback.
    ClearErrors
    FileOpen $3 "$portableFrom\updated-app.txt" w
    IfErrors failure
    FileWrite $3 "$INSTDIR\${APP_EXE}"
    FileClose $3
    IfErrors failure
  ${EndIf}
  ${If} $update != "1"
    CreateShortcut "$SMPROGRAMS\Triscord.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
    CreateShortcut "$DESKTOP\Triscord.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  ${EndIf}
  ${If} $nolaunch != "1"
    Exec '"$INSTDIR\${APP_EXE}"'
  ${EndIf}
  SetErrorLevel 0
  Return
failure:
  MessageBox MB_OK|MB_ICONSTOP "Não foi possível instalar o Triscord. Confira o espaço disponível e tente novamente." /SD IDOK
  SetErrorLevel 1
  Quit
SectionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Triscord.lnk"
  Delete "$DESKTOP\Triscord.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; Only the program folder; the parent keeps the user's data and goes away only if empty.
  RMDir /r "$INSTDIR"
  RMDir "$INSTDIR\.."
SectionEnd
