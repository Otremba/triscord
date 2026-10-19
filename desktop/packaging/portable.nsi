Unicode true
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!ifndef APP_EXE
!define APP_EXE "triscord-native.exe"
!endif

Name "Triscord"
Icon "${APP_ICON}"
!ifdef APP_VERSION
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1046 "ProductName" "Triscord"
VIAddVersionKey /LANG=1046 "FileDescription" "Triscord"
VIAddVersionKey /LANG=1046 "CompanyName" "Triscord"
VIAddVersionKey /LANG=1046 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1046 "ProductVersion" "${APP_VERSION}"
!endif
OutFile "${OUTPUT_EXE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
SetCompressor /SOLID lzma
CRCCheck force
ManifestDPIAware true
Var extractionMutex

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "O Triscord precisa de Windows de 64 bits."
    Abort
  ${EndIf}
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\TriscordNative\runtime\${PACKAGE_ID}"
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\TriscordPortableExtract-${PACKAGE_ID}") p.r0'
  StrCpy $extractionMutex $0
  ${If} $extractionMutex == 0
    MessageBox MB_OK|MB_ICONSTOP "Não foi possível preparar o Triscord. Tente abrir novamente."
    Abort
  ${EndIf}
  System::Call 'kernel32::WaitForSingleObject(p $extractionMutex, i 30000) i.r1'
  ${If} $1 != 0
  ${AndIf} $1 != 128
    System::Call 'kernel32::CloseHandle(p $extractionMutex)'
    MessageBox MB_OK|MB_ICONSTOP "O Triscord ainda está sendo preparado. Tente abrir novamente."
    Abort
  ${EndIf}
FunctionEnd

Section
  ; An update installs the new version separately and records it only after success.
  ; This pointer belongs to this package's runtime, never to a different portable build.
  IfFileExists "$INSTDIR\updated-app.txt" 0 original
  ClearErrors
  FileOpen $1 "$INSTDIR\updated-app.txt" r
  IfErrors original
  FileRead $1 $2
  FileClose $1
  IfFileExists "$2" updated original
updated:
  System::Call 'kernel32::ReleaseMutex(p $extractionMutex)'
  System::Call 'kernel32::CloseHandle(p $extractionMutex)'
  ${GetParent} "$2" $3
  SetOutPath "$3"
  ClearErrors
  Exec '"$2"'
  IfErrors launchFailure
  SetErrorLevel 0
  Quit
original:
  IfFileExists "$INSTDIR\complete.marker" 0 extract
  IfFileExists "$INSTDIR\${APP_EXE}" launch extract
extract:
  ClearErrors
  SetOutPath "$INSTDIR"
  System::Call 'kernel32::SetEnvironmentVariableW(w "TRISCORD_PORTABLE_RUNTIME", w "$INSTDIR")'
  SetOverwrite on
  File /r "${PACKAGE_DIR}\*"
  IfErrors failure
  FileOpen $1 "$INSTDIR\complete.marker" w
  IfErrors failure
  FileWrite $1 "${PACKAGE_ID}$\r$\n"
  FileClose $1
launch:
  System::Call 'kernel32::ReleaseMutex(p $extractionMutex)'
  System::Call 'kernel32::CloseHandle(p $extractionMutex)'
  SetOutPath "$INSTDIR"
  ClearErrors
  Exec '"$INSTDIR\${APP_EXE}"'
  IfErrors launchFailure
  SetErrorLevel 0
  Quit
failure:
  Delete "$INSTDIR\complete.marker"
  System::Call 'kernel32::ReleaseMutex(p $extractionMutex)'
  System::Call 'kernel32::CloseHandle(p $extractionMutex)'
  MessageBox MB_OK|MB_ICONSTOP "Não foi possível preparar os arquivos do Triscord. Confira o espaço disponível e tente novamente."
  SetErrorLevel 1
  Quit
launchFailure:
  MessageBox MB_OK|MB_ICONSTOP "Não foi possível abrir o Triscord. Tente abrir novamente."
  SetErrorLevel 1
SectionEnd
