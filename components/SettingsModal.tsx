
import React, { useState, useEffect } from 'react';
import { X, Globe, Cpu, Database, Save, AlertCircle, HardDrive, Cloud, FolderOpen, Check } from 'lucide-react';
import { Language, AppSettings, FirebaseConfig, StorageType } from '../types';
import { translations } from '../utils/translations';
import { storageService } from '../services/storageService';
import { isGeminiConfigured } from '../services/geminiService';
import { GEMINI_MODELS } from '../services/geminiModels.mjs';
import { aiSuggestionTranslations } from '../utils/aiSuggestionTranslations';

interface SettingsModalProps {
  currentLanguage: Language;
  onLanguageChange: (lang: Language) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ currentLanguage, onLanguageChange, onClose }) => {
  const t = translations[currentLanguage];
  const ai = aiSuggestionTranslations[currentLanguage];
  const [activeTab, setActiveTab] = useState<'general' | 'storage'>('general');
  const [settings, setSettings] = useState<AppSettings>(storageService.getSettings());
  const [fbConfig, setFbConfig] = useState<string>(
    JSON.stringify(settings.firebaseConfig || {
      apiKey: "",
      authDomain: "",
      projectId: "",
      storageBucket: "",
      messagingSenderId: "",
      appId: ""
    }, null, 2)
  );
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [fsConnected, setFsConnected] = useState<boolean>(
      settings.storageType === 'filesystem' && storageService.isFileSystemConnected()
  );

  const apiKeyPresent = isGeminiConfigured();

  const handleSaveSettings = () => {
    try {
      let parsedConfig: FirebaseConfig | undefined = undefined;
      
      if (settings.storageType === 'cloud') {
        parsedConfig = JSON.parse(fbConfig);
      }

      const newSettings: AppSettings = {
        ...settings,
        language: currentLanguage,
        firebaseConfig: parsedConfig
      };

      storageService.saveSettings(newSettings);
      setSettings(newSettings);
      
      if (newSettings.language !== currentLanguage) {
          onLanguageChange(newSettings.language);
      }
      
      setSaveStatus(t.configSaved);
      setTimeout(() => setSaveStatus(''), 2000);

    } catch (e) {
      setSaveStatus("Error: Invalid JSON Config");
    }
  };

  const handleConnectFileSystem = async () => {
      // Must save setting first to ensure service uses FS adapter
      storageService.saveSettings({ ...settings, storageType: 'filesystem' });
      const success = await storageService.connectFileSystem();
      setFsConnected(success);
      if(success) setSaveStatus(t.folderSelected);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 w-full max-w-2xl rounded-2xl border border-slate-700 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="flex justify-between items-center p-6 border-b border-slate-800 shrink-0">
          <h2 className="text-xl font-semibold text-white">{t.settingsTitle}</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 px-6 shrink-0">
            <button 
                onClick={() => setActiveTab('general')}
                className={`py-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'general' ? 'border-sepia-500 text-sepia-100' : 'border-transparent text-slate-400 hover:text-white'}`}
            >
                <Globe size={16} />
                {t.general}
            </button>
            <button 
                onClick={() => setActiveTab('storage')}
                className={`py-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'storage' ? 'border-sepia-500 text-sepia-100' : 'border-transparent text-slate-400 hover:text-white'}`}
            >
                <Database size={16} />
                {t.storage}
            </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          
          {activeTab === 'general' && (
              <div className="space-y-6">
                <fieldset className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/40 p-4">
                  <legend className="px-1 text-sm font-semibold text-slate-100">{ai.settingsTitle}</legend>
                  <p className="text-xs leading-relaxed text-slate-400">{ai.settingsHelp}</p>
                  {(['manual', 'automatic'] as const).map(mode => <label key={mode} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${(settings.suggestionMode || 'manual') === mode ? 'border-violet-500 bg-violet-950/30' : 'border-slate-700 bg-slate-900'}`}>
                    <input type="radio" name="suggestionMode" value={mode} aria-label={mode === 'manual' ? ai.manual : ai.automatic}
                      checked={(settings.suggestionMode || 'manual') === mode}
                      onChange={() => setSettings(current => ({ ...current, suggestionMode: mode }))}
                      className="mt-1 shrink-0 accent-violet-400" />
                    <span className="min-w-0 space-y-1">
                      <span className="block text-sm font-medium text-slate-100">{mode === 'manual' ? ai.manual : ai.automatic}</span>
                      <span className="block text-xs leading-relaxed text-slate-400">{mode === 'manual' ? ai.manualHelp : ai.automaticHelp}</span>
                    </span>
                  </label>)}
                  <p className="text-xs leading-relaxed text-violet-200">{ai.automaticReview}</p>
                  <p className="text-xs leading-relaxed text-slate-400">{ai.backgroundHelp}</p>
                </fieldset>
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-slate-300 font-medium">
                        <Cpu size={18} className="text-sepia-400" />
                        {t.apiStatusLabel}
                    </div>
                    <div className={`p-3 rounded-lg border flex items-center justify-between ${apiKeyPresent ? 'bg-emerald-950/30 border-emerald-800/50' : 'bg-red-950/30 border-red-800/50'}`}>
                        <span className={`font-medium ${apiKeyPresent ? 'text-emerald-400' : 'text-red-400'}`}>
                            {apiKeyPresent ? t.connected : t.disconnected}
                        </span>
                        <div className={`w-3 h-3 rounded-full ${apiKeyPresent ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`} />
                    </div>
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-4 space-y-3 text-sm">
                    <div>
                        <p className="font-medium text-slate-200">{currentLanguage === 'sk' ? 'Obnova fotografií' : 'Photo restoration'}</p>
                        <p className="text-slate-400">Nano Banana 2.1 · 2K</p>
                        <p className="text-xs text-slate-500">{currentLanguage === 'sk' ? 'Verná obnova tvárí, kompozície a prirodzených farieb.' : 'Conservative restoration of faces, composition and natural colors.'}</p>
                    </div>
                    <div>
                        <p className="font-medium text-slate-200">{currentLanguage === 'sk' ? 'Popisy a značky' : 'Captions and tags'}</p>
                        <p className="text-slate-400">{GEMINI_MODELS.analysis}</p>
                        <p className="text-xs text-slate-500">{currentLanguage === 'sk' ? 'Záložný model pri nedostupnosti: ' : 'Fallback when unavailable: '}{GEMINI_MODELS.analysisFallback}</p>
                    </div>
                    <a href="https://aistudio.google.com/usage" target="_blank" rel="noreferrer" className="inline-block text-sepia-400 underline">
                        {currentLanguage === 'sk' ? 'Využitie API a limity projektu' : 'API usage and project limits'}
                    </a>
                </div>

                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-slate-300 font-medium">
                        <Globe size={18} className="text-sepia-400" />
                        {t.languageLabel}
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                        <button 
                            onClick={() => onLanguageChange('en')}
                            className={`flex items-center justify-center gap-2 py-3 rounded-lg border transition-all ${
                                currentLanguage === 'en' 
                                ? 'bg-sepia-900/40 border-sepia-500 text-sepia-100' 
                                : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750'
                            }`}
                        >
                            <span className="text-xl">🇺🇸</span>
                            English
                        </button>
                        <button 
                            onClick={() => onLanguageChange('sk')}
                            className={`flex items-center justify-center gap-2 py-3 rounded-lg border transition-all ${
                                currentLanguage === 'sk' 
                                ? 'bg-sepia-900/40 border-sepia-500 text-sepia-100' 
                                : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750'
                            }`}
                        >
                            <span className="text-xl">🇸🇰</span>
                            Slovenský
                        </button>
                    </div>
                </div>
              </div>
          )}

          {activeTab === 'storage' && (
              <div className="space-y-6">
                 
                 <div className="space-y-3">
                    <div className="flex items-center gap-2 text-slate-300 font-medium">
                        <Database size={18} className="text-sepia-400" />
                        {t.storageType}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div 
                            onClick={() => setSettings({...settings, storageType: 'local'})}
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${settings.storageType === 'local' ? 'bg-sepia-900/20 border-sepia-500 ring-1 ring-sepia-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-750'}`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <HardDrive size={20} className={settings.storageType === 'local' ? 'text-sepia-400' : 'text-slate-400'} />
                                <span className="font-semibold text-white text-sm">{t.localStorage}</span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-relaxed">
                                {t.localStorageDesc}
                            </p>
                        </div>

                        <div 
                            onClick={() => setSettings({...settings, storageType: 'cloud'})}
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${settings.storageType === 'cloud' ? 'bg-sepia-900/20 border-sepia-500 ring-1 ring-sepia-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-750'}`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <Cloud size={20} className={settings.storageType === 'cloud' ? 'text-sepia-400' : 'text-slate-400'} />
                                <span className="font-semibold text-white text-sm">{t.cloudStorage}</span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-relaxed">
                                {t.cloudStorageDesc}
                            </p>
                        </div>
                        
                        <div 
                            onClick={() => setSettings({...settings, storageType: 'filesystem'})}
                            className={`p-3 rounded-xl border cursor-pointer transition-all ${settings.storageType === 'filesystem' ? 'bg-sepia-900/20 border-sepia-500 ring-1 ring-sepia-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-750'}`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <FolderOpen size={20} className={settings.storageType === 'filesystem' ? 'text-sepia-400' : 'text-slate-400'} />
                                <span className="font-semibold text-white text-sm">Local Native</span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-relaxed">
                                {t.filesystemStorageDesc}
                            </p>
                        </div>
                    </div>
                 </div>

                 {/* Filesystem Config */}
                 {settings.storageType === 'filesystem' && (
                     <div className="bg-slate-950 border border-sepia-900/50 rounded-lg p-4 animate-in fade-in slide-in-from-top-2">
                         <div className="flex items-center justify-between">
                            <span className="text-sm text-slate-300">
                                {fsConnected ? t.folderSelected : t.filesystemStorage}
                            </span>
                            <button 
                                onClick={handleConnectFileSystem}
                                className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors ${fsConnected ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/50' : 'bg-sepia-600 hover:bg-sepia-500 text-white'}`}
                            >
                                {fsConnected ? <Check size={16} /> : <FolderOpen size={16} />}
                                {fsConnected ? 'Connected' : t.selectFolder}
                            </button>
                         </div>
                         <p className="text-xs text-slate-500 mt-2">
                            Select a folder on your computer. All photos will be saved there as real files.
                         </p>
                     </div>
                 )}

                 {/* Firebase Config Input */}
                 {settings.storageType === 'cloud' && (
                     <div className="space-y-3 animate-in fade-in slide-in-from-top-4">
                        <div className="flex items-center justify-between">
                             <div className="flex items-center gap-2 text-slate-300 font-medium">
                                <AlertCircle size={18} className="text-sepia-400" />
                                {t.firebaseConfig}
                             </div>
                             <a href="https://firebase.google.com/docs/web/setup" target="_blank" rel="noreferrer" className="text-xs text-sepia-400 hover:underline">
                                Help
                             </a>
                        </div>
                        <textarea
                            value={fbConfig}
                            onChange={(e) => setFbConfig(e.target.value)}
                            className="w-full h-48 bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs font-mono text-slate-300 focus:ring-2 focus:ring-sepia-500 focus:outline-none"
                            placeholder='{ "apiKey": "...", ... }'
                        />
                     </div>
                 )}


              </div>
          )}

        </div>

        <div className="p-4 sm:p-6 space-y-3 border-t border-slate-800 bg-slate-900/50 shrink-0">
            <button type="button" onClick={handleSaveSettings} className="w-full bg-sepia-600 hover:bg-sepia-500 text-white font-medium py-2 rounded-lg transition-colors flex items-center justify-center gap-2">
                <Save size={18} />{t.saveSettings}
            </button>
            {saveStatus && <p role="status" className={`text-center text-sm ${saveStatus.includes('Error') ? 'text-red-400' : 'text-emerald-400'}`}>{saveStatus}</p>}
            <button onClick={onClose} className="w-full bg-slate-800 hover:bg-slate-700 text-white font-medium py-2 rounded-lg transition-colors border border-slate-700">
                {t.close}
            </button>
        </div>
      </div>
    </div>
  );
};
