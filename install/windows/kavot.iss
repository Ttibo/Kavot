; Inno Setup script for the Kavot Windows installer. Run through install/build.py,
; which passes AppVersion, SourceDir, OutputDir, OutputName and IconFile.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
; Keep this AppId forever: Windows uses it to upgrade and uninstall Kavot.
AppId={{88C47D98-E7D4-4C11-AA2B-77316D6123F6}
AppName=Kavot
AppVersion={#AppVersion}
AppPublisher=Kavot
AppPublisherURL=https://kavot.cloud
AppSupportURL=https://github.com/Ttibo/Kavot/issues
DefaultDirName={autopf}\Kavot
DefaultGroupName=Kavot
DisableProgramGroupPage=yes
; Installs for the current user without admin rights, or for everyone on request.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputName}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Kavot.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Kavot"; Filename: "{app}\Kavot.exe"
Name: "{autodesktop}\Kavot"; Filename: "{app}\Kavot.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Kavot.exe"; Description: "{cm:LaunchProgram,Kavot}"; Flags: nowait postinstall skipifsilent
