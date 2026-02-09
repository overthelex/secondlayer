import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Mail, Shield, CreditCard, Settings, Camera, BarChart3, Zap, Clock, ChevronRight, Edit2, Loader2, X, Phone, Save, Upload } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { authService } from '../services';
import showToast from '../utils/toast';
import { GdprPrivacySection } from './GdprPrivacySection';

export function ProfilePage() {
  const { user, isLoading, updateUser } = useAuth();
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Edit form state
  const [editForm, setEditForm] = useState({
    name: '',
    phone: '',
    picture: ''
  });

  // Debug: log user data
  useEffect(() => {
    console.log('ProfilePage - user data:', user);
    console.log('ProfilePage - isLoading:', isLoading);
  }, [user, isLoading]);

  // Initialize form when user data loads
  useEffect(() => {
    if (user) {
      setEditForm({
        name: user.name || '',
        phone: (user as any).phone || '',
        picture: user.picture || ''
      });
    }
  }, [user]);

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-claude-bg">
        <div className="text-center">
          <Loader2 size={48} className="text-claude-accent animate-spin mx-auto mb-4" />
          <p className="text-claude-text font-sans">Loading profile...</p>
        </div>
      </div>
    );
  }

  // Show error if no user data
  if (!user) {
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-claude-bg">
        <div className="text-center">
          <p className="text-claude-text font-sans mb-4">No user data available</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-claude-accent text-white rounded-xl font-medium hover:bg-[#C66345] transition-colors"
          >
            Reload Page
          </button>
        </div>
      </div>
    );
  }

  const handleEditProfile = () => {
    setIsEditModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsEditModalOpen(false);
    // Reset form to current user data
    if (user) {
      setEditForm({
        name: user.name || '',
        phone: (user as any).phone || '',
        picture: user.picture || ''
      });
    }
  };

  const handleSaveProfile = async () => {
    try {
      setIsSaving(true);

      // Update profile via API
      const updatedUser = await authService.updateProfile({
        name: editForm.name || undefined,
        phone: editForm.phone || undefined,
        picture: editForm.picture || undefined
      });

      // Update local user state
      updateUser(updatedUser);

      showToast.success('Профіль успішно оновлено');
      setIsEditModalOpen(false);
    } catch (error) {
      console.error('Failed to update profile:', error);
      showToast.error('Не вдалося оновити профіль');
    } finally {
      setIsSaving(false);
    }
  };

  const handlePhotoClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      showToast.error('Будь ласка, виберіть файл зображення');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      showToast.error('Розмір файлу не повинен перевищувати 5MB');
      return;
    }

    try {
      setIsUploadingPhoto(true);

      // Convert to base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;

        try {
          // Update profile with new photo
          const updatedUser = await authService.updateProfile({
            picture: base64
          });

          // Update local user state
          updateUser(updatedUser);
          setEditForm(prev => ({ ...prev, picture: base64 }));

          showToast.success('Фото профілю оновлено');
        } catch (error) {
          console.error('Failed to upload photo:', error);
          showToast.error('Не вдалося завантажити фото');
        } finally {
          setIsUploadingPhoto(false);
        }
      };

      reader.onerror = () => {
        showToast.error('Помилка читання файлу');
        setIsUploadingPhoto(false);
      };

      reader.readAsDataURL(file);
    } catch (error) {
      console.error('Error handling file:', error);
      showToast.error('Помилка обробки файлу');
      setIsUploadingPhoto(false);
    }
  };

  const handleShare = () => {
    const profileUrl = window.location.href;
    if (navigator.share) {
      navigator.share({
        title: `${user.name} - SecondLayer Profile`,
        url: profileUrl
      }).catch(() => {
        // Fallback to clipboard
        copyToClipboard(profileUrl);
      });
    } else {
      copyToClipboard(profileUrl);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      showToast.success('Посилання скопійовано');
    }).catch(() => {
      showToast.error('Не вдалося скопіювати посилання');
    });
  };

  const stats = [{
    label: 'Messages Sent',
    value: '1,248',
    icon: MessageIcon
  }, {
    label: 'Words Generated',
    value: '842k',
    icon: Zap
  }, {
    label: 'Time Saved',
    value: '124h',
    icon: Clock
  }];

  const settingsGroups = [{
    title: 'Account',
    items: [{
      icon: Mail,
      label: 'Email',
      value: user?.email || 'Not set'
    }, {
      icon: Shield,
      label: 'Authentication',
      value: 'Google OAuth'
    }, {
      icon: User,
      label: 'User ID',
      value: user?.id?.substring(0, 8) + '...' || 'N/A'
    }]
  }, {
    title: 'Application',
    items: [{
      icon: Settings,
      label: 'Language',
      value: 'Українська'
    }, {
      icon: CreditCard,
      label: 'Billing',
      value: 'Not configured',
      onClick: () => window.location.href = '/billing'
    }]
  }];

  return (
    <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative bg-white rounded-2xl p-6 md:p-8 border border-claude-border shadow-sm overflow-hidden"
        >
          <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-r from-claude-accent/10 to-claude-bg" />

          <div className="relative flex flex-col md:flex-row items-start md:items-end gap-6 pt-12">
            <div className="relative group">
              <input
                id="profile-photo-upload"
                name="profile-photo"
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="w-24 h-24 md:w-32 md:h-32 rounded-full bg-claude-sidebar border-4 border-white shadow-md flex items-center justify-center text-3xl font-serif text-claude-subtext overflow-hidden">
                {user?.picture ? (
                  <img
                    src={user.picture}
                    alt={user.name || 'User avatar'}
                    className="w-full h-full object-cover group-hover:opacity-50 transition-opacity duration-200"
                  />
                ) : (
                  <span className="group-hover:opacity-50 transition-opacity duration-200">
                    {user?.name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U'}
                  </span>
                )}
                {isUploadingPhoto && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 size={24} className="text-white animate-spin" />
                  </div>
                )}
                <div
                  onClick={handlePhotoClick}
                  className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/10 cursor-pointer"
                >
                  <Camera size={24} className="text-white" />
                </div>
              </div>
              <button
                onClick={handlePhotoClick}
                disabled={isUploadingPhoto}
                className="absolute bottom-0 right-0 p-2 bg-white rounded-full border border-claude-border shadow-sm text-claude-subtext hover:text-claude-accent transition-colors disabled:opacity-50"
              >
                <Edit2 size={14} />
              </button>
            </div>

            <div className="flex-1 mb-2">
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight">
                {user?.name || 'User'}
              </h1>
              <p className="text-claude-subtext mt-1 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                {user?.emailVerified && '✓ '}Verified • Member since {user?.createdAt ? new Date(user.createdAt).getFullYear() : new Date().getFullYear()}
              </p>
            </div>

            <div className="flex gap-3 w-full md:w-auto">
              <button
                onClick={handleEditProfile}
                className="flex-1 md:flex-none px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm hover:bg-[#C66345] transition-colors shadow-sm active:scale-[0.98]"
              >
                Edit Profile
              </button>
              <button
                onClick={handleShare}
                className="flex-1 md:flex-none px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm hover:bg-claude-bg transition-colors active:scale-[0.98]"
              >
                Share
              </button>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Left Column - Bio & Personal */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="md:col-span-2 space-y-8"
          >
            {/* Bio Section */}
            <section className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-serif text-claude-text">Profile Information</h2>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-claude-subtext">Email</label>
                  <p className="text-claude-text mt-1 flex items-center gap-2">
                    <Mail size={16} className="text-claude-subtext" />
                    {user?.email || 'Not available'}
                    {user?.emailVerified && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 border border-green-200 rounded-full text-xs text-green-700">
                        ✓ Verified
                      </span>
                    )}
                  </p>
                </div>

                {(user as any).phone && (
                  <div>
                    <label className="text-sm font-medium text-claude-subtext">Phone</label>
                    <p className="text-claude-text mt-1 flex items-center gap-2">
                      <Phone size={16} className="text-claude-subtext" />
                      {(user as any).phone}
                    </p>
                  </div>
                )}

                <div>
                  <label className="text-sm font-medium text-claude-subtext">Last Login</label>
                  <p className="text-claude-text mt-1">
                    {user?.lastLogin ? new Date(user.lastLogin).toLocaleString('uk-UA', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    }) : 'Not available'}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium text-claude-subtext">Account Created</label>
                  <p className="text-claude-text mt-1">
                    {user?.createdAt ? new Date(user.createdAt).toLocaleString('uk-UA', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric'
                    }) : 'Not available'}
                  </p>
                </div>
              </div>
            </section>

            {/* Settings Groups */}
            <div className="space-y-6">
              {settingsGroups.map((group) => (
                <section key={group.title} className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-claude-border/50 bg-claude-bg/30">
                    <h3 className="text-sm font-semibold text-claude-subtext uppercase tracking-wider">
                      {group.title}
                    </h3>
                  </div>
                  <div className="divide-y divide-claude-border/50">
                    {group.items.map((item) => (
                      <button
                        key={item.label}
                        onClick={item.onClick}
                        className="w-full px-6 py-4 flex items-center justify-between hover:bg-claude-bg/50 transition-colors group"
                      >
                        <div className="flex items-center gap-4">
                          <div className="p-2 bg-claude-bg rounded-lg text-claude-subtext group-hover:text-claude-accent transition-colors">
                            <item.icon size={18} />
                          </div>
                          <div className="text-left">
                            <div className="text-sm font-medium text-claude-text">
                              {item.label}
                            </div>
                            <div className="text-xs text-claude-subtext">
                              {item.value}
                            </div>
                          </div>
                        </div>
                        <ChevronRight size={16} className="text-claude-border group-hover:text-claude-subtext transition-colors" />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            {/* GDPR Privacy Section */}
            <section className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <GdprPrivacySection />
            </section>
          </motion.div>

          {/* Right Column - Stats & Info */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-6"
          >
            {/* Usage Stats */}
            <section className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <h2 className="text-xl font-serif text-claude-text mb-6">
                Activity
              </h2>
              <div className="space-y-4">
                {stats.map((stat) => (
                  <div key={stat.label} className="flex items-center gap-4 p-3 rounded-xl hover:bg-claude-bg/50 transition-colors border border-transparent hover:border-claude-border/50">
                    <div className="p-2.5 rounded-lg bg-claude-accent/10 text-claude-accent">
                      <stat.icon size={18} />
                    </div>
                    <div>
                      <div className="text-2xl font-serif text-claude-text leading-none mb-1">
                        {stat.value}
                      </div>
                      <div className="text-xs font-medium text-claude-subtext uppercase tracking-wide">
                        {stat.label}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 pt-6 border-t border-claude-border/50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-claude-text">
                    Monthly Usage
                  </span>
                  <span className="text-sm text-claude-subtext">78%</span>
                </div>
                <div className="h-2 w-full bg-claude-bg rounded-full overflow-hidden">
                  <div className="h-full bg-claude-accent w-[78%] rounded-full" />
                </div>
                <p className="text-xs text-claude-subtext mt-2">
                  Resets in 12 days
                </p>
              </div>
            </section>

            {/* Pro Card */}
            <div className="bg-gradient-to-br from-claude-text to-gray-800 rounded-2xl p-6 text-white shadow-lg relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-16 -mt-16 blur-2xl group-hover:bg-white/10 transition-colors duration-500" />

              <div className="relative z-10">
                <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-white/10 rounded-full text-xs font-medium mb-4 border border-white/10">
                  <span className="w-1.5 h-1.5 rounded-full bg-claude-accent" />
                  Pro Plan
                </div>
                <h3 className="text-xl font-serif mb-2">
                  Upgrade your workflow
                </h3>
                <p className="text-white/70 text-sm mb-6 leading-relaxed">
                  Get access to advanced models, longer context window, and
                  priority support.
                </p>
                <button
                  onClick={() => window.location.href = '/billing'}
                  className="w-full py-2.5 bg-white text-claude-text rounded-xl font-medium text-sm hover:bg-gray-50 transition-colors active:scale-[0.98]"
                >
                  Manage Subscription
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      </div>

      {/* Edit Profile Modal */}
      <AnimatePresence>
        {isEditModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={handleCloseModal}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 bg-white border-b border-claude-border px-6 py-4 flex items-center justify-between z-10">
                <h2 className="text-xl font-serif text-claude-text">Edit Profile</h2>
                <button
                  onClick={handleCloseModal}
                  className="p-2 hover:bg-claude-bg rounded-lg transition-colors"
                >
                  <X size={20} className="text-claude-subtext" />
                </button>
              </div>

              <div className="p-6 space-y-4">
                {/* Avatar Preview */}
                <div className="flex flex-col items-center gap-4">
                  <div className="w-24 h-24 rounded-full bg-claude-sidebar border-4 border-claude-bg flex items-center justify-center text-2xl font-serif text-claude-subtext overflow-hidden">
                    {editForm.picture ? (
                      <img
                        src={editForm.picture}
                        alt="Avatar preview"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span>
                        {editForm.name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U'}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={handlePhotoClick}
                    disabled={isUploadingPhoto}
                    className="px-4 py-2 bg-claude-bg border border-claude-border rounded-lg text-sm font-medium text-claude-text hover:bg-claude-sidebar transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    {isUploadingPhoto ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Upload size={16} />
                    )}
                    {isUploadingPhoto ? 'Uploading...' : 'Change Photo'}
                  </button>
                </div>

                {/* Name Field */}
                <div>
                  <label htmlFor="profile-name" className="block text-sm font-medium text-claude-text mb-2">
                    Full Name
                  </label>
                  <input
                    id="profile-name"
                    name="name"
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent focus:border-transparent transition-all"
                    placeholder="Enter your name"
                  />
                </div>

                {/* Phone Field */}
                <div>
                  <label htmlFor="profile-phone" className="block text-sm font-medium text-claude-text mb-2">
                    Phone Number (optional)
                  </label>
                  <input
                    id="profile-phone"
                    name="phone"
                    type="tel"
                    value={editForm.phone}
                    onChange={(e) => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-claude-border rounded-lg focus:outline-none focus:ring-2 focus:ring-claude-accent focus:border-transparent transition-all"
                    placeholder="+380 XX XXX XX XX"
                  />
                </div>

                {/* Email Field (Read-only) */}
                <div>
                  <label className="block text-sm font-medium text-claude-text mb-2">
                    Email
                  </label>
                  <div className="w-full px-4 py-2.5 border border-claude-border rounded-lg bg-claude-bg text-claude-subtext flex items-center gap-2">
                    <Mail size={16} />
                    {user?.email}
                  </div>
                  <p className="text-xs text-claude-subtext mt-1">
                    Email cannot be changed for security reasons
                  </p>
                </div>
              </div>

              <div className="sticky bottom-0 bg-white border-t border-claude-border px-6 py-4 flex gap-3">
                <button
                  onClick={handleCloseModal}
                  className="flex-1 px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm hover:bg-claude-bg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveProfile}
                  disabled={isSaving}
                  className="flex-1 px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm hover:bg-[#C66345] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isSaving ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save size={16} />
                      Save Changes
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MessageIcon(props: any) {
  return (
    <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
