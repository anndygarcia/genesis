import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

const isConfigured = Boolean(supabaseUrl && supabaseAnonKey)

function makeStubClient() {
  // Minimal surface used by the app. Everything is harmless and non-throwing.
  // eslint-disable-next-line no-console
  console.warn('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Running in demo mode (no auth, no DB).')

  const noAuthErr = (action: string) => {
    // eslint-disable-next-line no-console
    console.warn(`[Supabase] ${action} skipped — Supabase not configured.`)
  }

  const stub = {
    auth: {
      async getSession() { return { data: { session: null }, error: null as any } },
      onAuthStateChange(_cb: any) {
        return { data: { subscription: { unsubscribe() {} } } } as any
      },
      async signInWithPassword() { noAuthErr('signInWithPassword'); return { data: { user: null, session: null }, error: { message: 'Not configured' } as any } },
      async signUp() { noAuthErr('signUp'); return { data: { user: null, session: null }, error: { message: 'Not configured' } as any } },
      async signOut() { noAuthErr('signOut'); return { error: null as any } },
      async getUser() { return { data: { user: null }, error: null as any } },
    },
    storage: {
      from(_bucket: string) {
        return {
          async upload(_path: string, _file: File, _opts?: any) {
            noAuthErr('storage.upload')
            return { data: null, error: { message: 'Not configured' } as any }
          },
          getPublicUrl(_path: string) {
            return { data: { publicUrl: '' }, error: null as any }
          },
        }
      },
    },
    from(_table: string) {
      // Chainable query builder that returns empty data
      const qb: any = {
        insert() { return qb },
        select() { return qb },
        single() { return qb },
        eq() { return qb },
        order() { return qb },
        limit() { return qb },
        then(resolver: any) { resolver({ data: [], error: null }); return Promise.resolve({ data: [], error: null }) },
      }
      return qb
    },
  }
  return stub as unknown as ReturnType<typeof createClient>
}

export const supabase = isConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!)
  : makeStubClient()

// Explicitly enable robust auth behavior in the browser so uploads run as the authenticated user.
// Although these defaults are enabled in most environments, we set them to be safe.
// Note: If you already had a client instance, you can ignore this comment.

export async function uploadReferenceImages(
  files: File[],
  bucket = (import.meta.env.VITE_SUPABASE_STORAGE_BUCKET as string) || 'references'
): Promise<string[]> {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData?.user?.id ?? 'anonymous'

  const uploadedPaths: string[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop() || 'bin'
    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`

    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, { contentType: file.type || `image/${ext}`, cacheControl: '3600', upsert: false })

    if (!error) {
      uploadedPaths.push(path)
    } else {
      // eslint-disable-next-line no-console
      console.error('[Supabase] Upload failed:', error.message)
    }
  }

  // Resolve public URLs
  const urls: string[] = []
  for (const path of uploadedPaths) {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path)
    if (data?.publicUrl) urls.push(data.publicUrl)
  }
  return urls
}

// Project types (align with your Supabase schema)
export type ProjectInsert = {
  name: string
  location?: string | null
  style?: string | null
  sqft?: number | null
  price_amount?: number | null
  image_urls?: string[] | null
  created_by: string
  is_public?: boolean
}

export type Project = ProjectInsert & {
  id: string
  created_at: string
}

// Create a project record
export async function createProject(input: Omit<ProjectInsert, 'created_by'> & { created_by?: string }) {
  const { data: userData } = await supabase.auth.getUser()
  const uid = input.created_by || userData?.user?.id
  if (!uid) throw new Error('Not authenticated')

  const payload: ProjectInsert = {
    name: input.name,
    location: input.location ?? null,
    style: input.style ?? null,
    sqft: input.sqft ?? null,
    price_amount: input.price_amount ?? null,
    image_urls: input.image_urls ?? [],
    created_by: uid,
    is_public: input.is_public ?? true,
  }

  if (!isConfigured) {
    // Demo mode: pretend insert succeeded and return a placeholder
    return {
      id: 'demo-project',
      created_at: new Date().toISOString(),
      ...payload,
    } as Project
  }
  const { data, error } = await supabase.from('projects').insert(payload).select('*').single()
  if (error) throw error
  return data as Project
}

// List public projects for feed
export async function listPublicProjects(): Promise<Project[]> {
  if (!isConfigured) return []
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as Project[]
}

// List current user's projects
export async function listUserProjects(): Promise<Project[]> {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData?.user?.id
  if (!uid || !isConfigured) return []
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('created_by', uid)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return (data ?? []) as Project[]
}
