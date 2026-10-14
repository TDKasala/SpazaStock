import React, { useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { Input, type InputProps } from '../ui/Input';
import { PASSWORD_MAX_LENGTH } from '../../lib/authValidation';

export const PasswordInput: React.FC<Omit<InputProps, 'type' | 'leftIcon' | 'rightIcon'>> = (props) => {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      type={visible ? 'text' : 'password'}
      maxLength={PASSWORD_MAX_LENGTH}
      leftIcon={<Lock className="w-4 h-4" />}
      rightIcon={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="p-1 -m-1 text-zinc-400 hover:text-zinc-200"
          aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      }
    />
  );
};
