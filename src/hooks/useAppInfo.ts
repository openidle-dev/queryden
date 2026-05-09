import { useState, useEffect } from 'react';
import { getAppConfig, APP_NAME_FALLBACK, APP_VERSION_FALLBACK } from '../config/app';

export function useAppInfo() {
  const [appInfo, setAppInfo] = useState({ 
    name: APP_NAME_FALLBACK, 
    version: APP_VERSION_FALLBACK 
  });

  useEffect(() => {
    getAppConfig().then(info => {
      setAppInfo(info);
    });
  }, []);

  return appInfo;
}