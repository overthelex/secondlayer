import React from 'react';
import { motion } from 'framer-motion';
import { User, Mail, Shield, CreditCard, Settings, Camera, BarChart3, Zap, Clock, ChevronRight, Edit2 } from 'lucide-react';
export function ProfilePage() {
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
      label: 'Email Preferences',
      value: 'Weekly Digest'
    }, {
      icon: Shield,
      label: 'Security & Privacy',
      value: '2FA Enabled'
    }, {
      icon: CreditCard,
      label: 'Billing & Plans',
      value: 'Pro Plan'
    }]
  }, {
    title: 'Application',
    items: [{
      icon: Settings,
      label: 'General Settings',
      value: 'English'
    }, {
      icon: User,
      label: 'Profile Visibility',
      value: 'Public'
    }]
  }];
  return <div className="flex-1 h-full overflow-y-auto bg-claude-bg p-4 md:p-8 lg:p-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header Section */}
        <motion.div initial={{
        opacity: 0,
        y: 20
      }} animate={{
        opacity: 1,
        y: 0
      }} transition={{
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1]
      }} className="relative bg-white rounded-2xl p-6 md:p-8 border border-claude-border shadow-sm overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-r from-claude-accent/10 to-claude-bg" />

          <div className="relative flex flex-col md:flex-row items-start md:items-end gap-6 pt-12">
            <div className="relative group">
              <div className="w-24 h-24 md:w-32 md:h-32 rounded-full bg-claude-sidebar border-4 border-white shadow-md flex items-center justify-center text-3xl font-serif text-claude-subtext overflow-hidden">
                <span className="group-hover:opacity-50 transition-opacity duration-200">
                  JD
                </span>
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 bg-black/10 cursor-pointer">
                  <Camera size={24} className="text-claude-text" />
                </div>
              </div>
              <button className="absolute bottom-0 right-0 p-2 bg-white rounded-full border border-claude-border shadow-sm text-claude-subtext hover:text-claude-accent transition-colors">
                <Edit2 size={14} />
              </button>
            </div>

            <div className="flex-1 mb-2">
              <h1 className="text-3xl md:text-4xl font-serif text-claude-text font-medium tracking-tight">
                John Doe
              </h1>
              <p className="text-claude-subtext mt-1 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                Pro Member since 2023
              </p>
            </div>

            <div className="flex gap-3 w-full md:w-auto">
              <button className="flex-1 md:flex-none px-4 py-2.5 bg-claude-accent text-white rounded-xl font-medium text-sm hover:bg-[#C66345] transition-colors shadow-sm active:scale-[0.98]">
                Edit Profile
              </button>
              <button className="flex-1 md:flex-none px-4 py-2.5 bg-white border border-claude-border text-claude-text rounded-xl font-medium text-sm hover:bg-claude-bg transition-colors active:scale-[0.98]">
                Share
              </button>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Left Column - Bio & Personal */}
          <motion.div initial={{
          opacity: 0,
          y: 20
        }} animate={{
          opacity: 1,
          y: 0
        }} transition={{
          duration: 0.5,
          delay: 0.1,
          ease: [0.22, 1, 0.36, 1]
        }} className="md:col-span-2 space-y-8">
            {/* Bio Section */}
            <section className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-serif text-claude-text">About</h2>
                <button className="text-xs font-medium text-claude-accent hover:text-[#C66345] uppercase tracking-wide">
                  Edit
                </button>
              </div>
              <p className="text-claude-subtext leading-relaxed">
                Product Designer and Creative Technologist based in San
                Francisco. Passionate about building tools that enhance human
                creativity. Currently exploring the intersection of AI and
                interface design.
              </p>

              <div className="mt-6 flex flex-wrap gap-2">
                {['Product Design', 'React', 'AI/ML', 'Typography', 'UX Research'].map((tag) => <span key={tag} className="px-3 py-1 bg-claude-bg border border-claude-border rounded-full text-xs font-medium text-claude-subtext">
                    {tag}
                  </span>)}
              </div>
            </section>

            {/* Settings Groups */}
            <div className="space-y-6">
              {settingsGroups.map((group, idx) => <section key={group.title} className="bg-white rounded-2xl border border-claude-border shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-claude-border/50 bg-claude-bg/30">
                    <h3 className="text-sm font-semibold text-claude-subtext uppercase tracking-wider">
                      {group.title}
                    </h3>
                  </div>
                  <div className="divide-y divide-claude-border/50">
                    {group.items.map((item) => <button key={item.label} className="w-full px-6 py-4 flex items-center justify-between hover:bg-claude-bg/50 transition-colors group">
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
                      </button>)}
                  </div>
                </section>)}
            </div>
          </motion.div>

          {/* Right Column - Stats & Info */}
          <motion.div initial={{
          opacity: 0,
          y: 20
        }} animate={{
          opacity: 1,
          y: 0
        }} transition={{
          duration: 0.5,
          delay: 0.2,
          ease: [0.22, 1, 0.36, 1]
        }} className="space-y-6">
            {/* Usage Stats */}
            <section className="bg-white rounded-2xl p-6 border border-claude-border shadow-sm">
              <h2 className="text-xl font-serif text-claude-text mb-6">
                Activity
              </h2>
              <div className="space-y-4">
                {stats.map((stat) => <div key={stat.label} className="flex items-center gap-4 p-3 rounded-xl hover:bg-claude-bg/50 transition-colors border border-transparent hover:border-claude-border/50">
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
                  </div>)}
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
                <button className="w-full py-2.5 bg-white text-claude-text rounded-xl font-medium text-sm hover:bg-gray-50 transition-colors active:scale-[0.98]">
                  Manage Subscription
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </div>;
}
function MessageIcon(props: any) {
  return <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>;
}