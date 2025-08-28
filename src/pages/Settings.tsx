import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

function Settings() {
  // Account
  const [email, setEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)
  const [accountSaved, setAccountSaved] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)

  // Appearance
  const [theme, setTheme] = useState<'system' | 'dark' | 'light'>('system')
  const [accent, setAccent] = useState('#a588ef')
  const [savingAppearance, setSavingAppearance] = useState(false)
  const [appearanceSaved, setAppearanceSaved] = useState<string | null>(null)

  // Notifications
  const [emailNotif, setEmailNotif] = useState(true)
  const [productUpdates, setProductUpdates] = useState(true)
  const [marketing, setMarketing] = useState(false)
  const [savingNotif, setSavingNotif] = useState(false)
  const [notifSaved, setNotifSaved] = useState<string | null>(null)

  // Payment Info (local only for now)
  const [plan, setPlan] = useState<'Free' | 'Pro'>(() => (localStorage.getItem('billing.plan') as 'Free' | 'Pro') || 'Free')
  const [upgrading, setUpgrading] = useState(false)
  const [managing, setManaging] = useState(false)
  const [billingMsg, setBillingMsg] = useState<string | null>(null)

  useEffect(() => {
    // Prefill from Supabase auth user if available
    (async () => {
      const { data } = await supabase.auth.getUser()
      const user = data.user
      if (user) {
        setEmail(user.email ?? '')
      }
    })()
  }, [])

  const transient = (setter: (v: string | null) => void, msg = 'Saved') => {
    setter(msg)
    setTimeout(() => setter(null), 1500)
  }

  const saveAccount = async () => {
    setAccountError(null)
    setSavingAccount(true)
    try {
      if (newPassword || confirmPassword || currentPassword) {
        if (newPassword.length < 6) {
          setAccountError('New password must be at least 6 characters')
          return
        }
        if (newPassword !== confirmPassword) {
          setAccountError('Passwords do not match')
          return
        }
        // TODO: call supabase.auth.updateUser({ password: newPassword })
        await new Promise((r) => setTimeout(r, 600))
      }
      transient(setAccountSaved)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } finally {
      setSavingAccount(false)
    }
  }

  const saveAppearance = async () => {
    setSavingAppearance(true)
    try {
      // Persist in localStorage for now
      localStorage.setItem('app.theme', theme)
      localStorage.setItem('app.accent', accent)
      transient(setAppearanceSaved)
    } finally {
      setSavingAppearance(false)
    }
  }

  const saveNotifications = async () => {
    setSavingNotif(true)
    try {
      // Persist in localStorage for now
      localStorage.setItem('notif.email', String(emailNotif))
      localStorage.setItem('notif.updates', String(productUpdates))
      localStorage.setItem('notif.marketing', String(marketing))
      transient(setNotifSaved)
    } finally {
      setSavingNotif(false)
    }
  }

  // Payment stubs
  const startUpgrade = async () => {
    setUpgrading(true)
    setBillingMsg(null)
    try {
      // TODO: Create Checkout Session with your backend (Stripe recommended; free in test mode)
      // Placeholder: simulate successful upgrade
      await new Promise((r) => setTimeout(r, 800))
      setPlan('Pro')
      localStorage.setItem('billing.plan', 'Pro')
      setBillingMsg('Upgraded to Pro (simulated).')
    } finally {
      setUpgrading(false)
      setTimeout(() => setBillingMsg(null), 2000)
    }
  }

  const openBillingPortal = async () => {
    setManaging(true)
    setBillingMsg(null)
    try {
      // TODO: Call backend endpoint to create a Stripe Billing Portal session and redirect
      await new Promise((r) => setTimeout(r, 600))
      setBillingMsg('Opened billing portal (simulated).')
    } finally {
      setManaging(false)
      setTimeout(() => setBillingMsg(null), 2000)
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-semibold text-white">Settings</h1>
      <p className="mt-2 text-neutral-400">Manage your account and application preferences.</p>

      {/* Account */}
      <section className="mt-8 rounded-xl border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-lg font-semibold text-white">Account</h2>
        <p className="text-sm text-neutral-400">Email and password.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="text-sm text-neutral-300">Email</label>
            <input value={email} onChange={(e)=>setEmail(e.target.value)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60" placeholder="name@company.com" type="email" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">Current password</label>
            <input value={currentPassword} onChange={(e)=>setCurrentPassword(e.target.value)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60 input-dark" type="password" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">New password</label>
            <input value={newPassword} onChange={(e)=>setNewPassword(e.target.value)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60 input-dark" type="password" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">Confirm password</label>
            <input value={confirmPassword} onChange={(e)=>setConfirmPassword(e.target.value)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60 input-dark" type="password" />
          </div>
        </div>
        {accountError && <p className="mt-2 text-sm text-red-400">{accountError}</p>}
        <div className="mt-4 flex items-center gap-3">
          <button onClick={saveAccount} disabled={savingAccount} className="btn-accent px-4 py-2 rounded-md disabled:opacity-60">{savingAccount ? 'Saving…' : 'Save account'}</button>
          {accountSaved && <span className="text-sm text-neutral-400">{accountSaved}</span>}
        </div>
      </section>

      {/* Appearance */}
      <section className="mt-8 rounded-xl border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-lg font-semibold text-white">Appearance</h2>
        <p className="text-sm text-neutral-400">Theme and accent color.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">Theme</label>
            <select value={theme} onChange={(e)=>setTheme(e.target.value as any)} className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white">
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-neutral-300">Accent color</label>
            <input type="color" value={accent} onChange={(e)=>setAccent(e.target.value)} className="h-10 w-16 rounded-md bg-neutral-800 border border-white/10 p-1" />
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={saveAppearance} disabled={savingAppearance} className="btn-accent px-4 py-2 rounded-md disabled:opacity-60">{savingAppearance ? 'Saving…' : 'Save appearance'}</button>
          {appearanceSaved && <span className="text-sm text-neutral-400">{appearanceSaved}</span>}
        </div>
      </section>

      {/* Notifications */}
      <section className="mt-8 rounded-xl border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-lg font-semibold text-white">Notifications</h2>
        <p className="text-sm text-neutral-400">Choose what you want to hear about.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-3 text-neutral-300">
            <input type="checkbox" checked={emailNotif} onChange={(e)=>setEmailNotif(e.target.checked)} />
            Email me when important events happen
          </label>
          <label className="flex items-center gap-3 text-neutral-300">
            <input type="checkbox" checked={productUpdates} onChange={(e)=>setProductUpdates(e.target.checked)} />
            Product updates
          </label>
          <label className="flex items-center gap-3 text-neutral-300">
            <input type="checkbox" checked={marketing} onChange={(e)=>setMarketing(e.target.checked)} />
            Occasional marketing emails
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={saveNotifications} disabled={savingNotif} className="btn-accent px-4 py-2 rounded-md disabled:opacity-60">{savingNotif ? 'Saving…' : 'Save notifications'}</button>
          {notifSaved && <span className="text-sm text-neutral-400">{notifSaved}</span>}
        </div>
      </section>

      {/* Payment Info */}
      <section className="mt-8 rounded-xl border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-lg font-semibold text-white">Payment Info</h2>
        <p className="text-sm text-neutral-400">Manage your plan and billing.</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {/* Current plan */}
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
            <h3 className="font-medium text-white">Current plan</h3>
            <p className="mt-1 text-sm text-neutral-400">You are on the <span className="text-white font-medium">{plan}</span> plan.</p>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={startUpgrade} disabled={upgrading || plan === 'Pro'} className="btn-accent px-4 py-2 rounded-md disabled:opacity-60">
                {plan === 'Pro' ? 'Pro active' : upgrading ? 'Upgrading…' : 'Upgrade to Pro'}
              </button>
              {plan === 'Pro' && <span className="text-xs text-neutral-400">Thank you for supporting us!</span>}
            </div>
          </div>

          {/* Billing */}
          <div className="rounded-lg border border-white/10 bg-neutral-900/60 p-4">
            <h3 className="font-medium text-white">Billing</h3>
            <p className="mt-1 text-sm text-neutral-400">Update payment method and view invoices.</p>
            <div className="mt-3 flex items-center gap-3">
              <button onClick={openBillingPortal} disabled={managing} className="btn-accent px-4 py-2 rounded-md disabled:opacity-60">
                {managing ? 'Opening…' : 'Manage billing'}
              </button>
              {billingMsg && <span className="text-sm text-neutral-400">{billingMsg}</span>}
            </div>
          </div>
        </div>

        {/* TODO notes */}
        <p className="mt-4 text-xs text-neutral-500">
          TODO: Integrate Stripe. Create backend endpoints to (1) create a Checkout Session for upgrades and (2) create a Billing Portal session. Use test mode to accept payments without real charges.
        </p>
      </section>
    </div>
  )
}

export default Settings
