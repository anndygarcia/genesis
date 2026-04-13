// OpenAI function calling schemas for Create Studio AI assistant

export type PrimitiveKind = 'box' | 'wall' | 'door' | 'window'

export interface StudioObject {
  id: string
  kind: PrimitiveKind
  name: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
  color: string
  opacity: number
  roughness: number
  metalness: number
}

type ToolCallArguments = Record<string, any>

function parseToolCallArguments(input: any): ToolCallArguments | null {
  if (!input) return null
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  if (typeof input === 'object') {
    return input as ToolCallArguments
  }
  return null
}

function createStudioObject(params: {
  kind: PrimitiveKind
  name: string
  position: [number, number, number]
  scale: [number, number, number]
  rotation?: [number, number, number]
  color?: string
  opacity?: number
  roughness?: number
  metalness?: number
}): StudioObject {
  const { kind, name, position, scale, rotation = [0, 0, 0], color, opacity, roughness, metalness } = params
  return {
    id: crypto.randomUUID(),
    kind,
    name,
    position,
    rotation,
    scale,
    color: color || getDefaultColor(kind),
    opacity: typeof opacity === 'number' ? opacity : getDefaultOpacity(kind),
    roughness: typeof roughness === 'number' ? roughness : (kind === 'wall' ? 0.7 : 0.05),
    metalness: typeof metalness === 'number' ? metalness : 0.1,
  }
}

function getRoomPalette(style: string) {
  const normalized = style.toLowerCase()
  if (normalized === 'industrial') {
    return { wall: '#c7c7c7', accent: '#8d8d8d', furniture: '#6d6d6d', warm: '#9a7b5e' }
  }
  if (normalized === 'traditional') {
    return { wall: '#e0d4c4', accent: '#c8b08a', furniture: '#8f6a4a', warm: '#b68f62' }
  }
  if (normalized === 'minimalist') {
    return { wall: '#f0f0f0', accent: '#d1d1d1', furniture: '#bcbcbc', warm: '#d8d8d8' }
  }
  return { wall: '#dadada', accent: '#c7c7c7', furniture: '#b9b9b9', warm: '#d6c4a4' }
}

function buildRoomLayout(args: ToolCallArguments): StudioObject[] {
  const roomType = String(args.room_type || 'living_room').toLowerCase()
  const style = String(args.style || 'modern').toLowerCase()
  const width = Math.max(2.5, Number(args.width) || 5)
  const depth = Math.max(2.5, Number(args.depth) || 5)
  const height = Math.max(2.4, Number(args.height) || 2.6)
  const wallThickness = Math.min(0.18, Math.max(0.1, Math.min(width, depth) * 0.03))
  const palette = getRoomPalette(style)
  const halfW = width / 2
  const halfD = depth / 2
  const wallY = height / 2

  const objects: StudioObject[] = [
    createStudioObject({
      kind: 'wall',
      name: 'North Wall',
      position: [0, wallY, -halfD],
      scale: [width, height, wallThickness],
      color: palette.wall,
      roughness: 0.72,
    }),
    createStudioObject({
      kind: 'wall',
      name: 'South Wall',
      position: [0, wallY, halfD],
      scale: [width, height, wallThickness],
      color: palette.wall,
      roughness: 0.72,
    }),
    createStudioObject({
      kind: 'wall',
      name: 'West Wall',
      position: [-halfW, wallY, 0],
      scale: [wallThickness, height, depth],
      color: palette.wall,
      roughness: 0.72,
    }),
    createStudioObject({
      kind: 'wall',
      name: 'East Wall',
      position: [halfW, wallY, 0],
      scale: [wallThickness, height, depth],
      color: palette.wall,
      roughness: 0.72,
    }),
    createStudioObject({
      kind: 'door',
      name: 'Entry Door',
      position: [0, 1.1, halfD - wallThickness * 0.5],
      scale: [1.0, 2.2, 0.08],
      color: '#86b7ff',
      opacity: 0.22,
      roughness: 0.05,
      metalness: 0,
    }),
  ]

  const addBox = (
    name: string,
    position: [number, number, number],
    scale: [number, number, number],
    color = palette.furniture,
    roughness = 0.45,
    metalness = 0.06,
  ) => {
    objects.push(createStudioObject({ kind: 'box', name, position, scale, color, roughness, metalness }))
  }

  const furnitureZ = depth * 0.12
  const sideInset = Math.max(0.55, Math.min(1.2, width * 0.18))

  if (roomType === 'bedroom') {
    addBox('Bed', [0, 0.4, -furnitureZ], [2.1, 0.8, 1.8], palette.warm, 0.5, 0.04)
    addBox('Nightstand', [-1.35, 0.3, -0.5], [0.5, 0.55, 0.5], palette.accent, 0.58, 0.03)
    addBox('Nightstand', [1.35, 0.3, -0.5], [0.5, 0.55, 0.5], palette.accent, 0.58, 0.03)
    addBox('Wardrobe', [halfW - sideInset, 1.0, -halfD * 0.35], [0.8, 2.0, 0.6], palette.furniture, 0.65, 0.05)
  } else if (roomType === 'kitchen') {
    addBox('Counter', [-halfW + sideInset, 0.9, -halfD * 0.2], [2.6, 0.9, 0.65], palette.accent, 0.6, 0.05)
    addBox('Island', [0, 0.9, 0.2], [1.8, 0.9, 0.95], palette.warm, 0.55, 0.05)
    addBox('Dining Table', [halfW * 0.25, 0.75, halfD * 0.28], [1.4, 0.75, 0.9], palette.furniture, 0.5, 0.04)
    addBox('Cabinet', [halfW - sideInset, 1.2, halfD * 0.25], [1.0, 2.2, 0.55], palette.accent, 0.62, 0.05)
  } else if (roomType === 'office') {
    addBox('Desk', [0, 0.75, -furnitureZ], [1.6, 0.75, 0.8], palette.warm, 0.5, 0.06)
    addBox('Chair', [0, 0.45, 0.6], [0.6, 0.9, 0.6], palette.furniture, 0.5, 0.08)
    addBox('Shelf', [halfW - sideInset, 1.1, -halfD * 0.15], [0.9, 2.1, 0.4], palette.accent, 0.65, 0.04)
  } else if (roomType === 'dining_room') {
    addBox('Dining Table', [0, 0.75, 0], [1.9, 0.75, 1.0], palette.warm, 0.48, 0.05)
    addBox('Chair', [-1.0, 0.45, 0], [0.5, 0.9, 0.5], palette.furniture, 0.5, 0.06)
    addBox('Chair', [1.0, 0.45, 0], [0.5, 0.9, 0.5], palette.furniture, 0.5, 0.06)
    addBox('Sideboard', [halfW - sideInset, 0.9, -halfD * 0.35], [1.4, 0.9, 0.5], palette.accent, 0.6, 0.05)
  } else if (roomType === 'bathroom') {
    addBox('Vanity', [-halfW + sideInset, 0.45, -halfD * 0.2], [1.2, 0.9, 0.55], palette.accent, 0.55, 0.04)
    addBox('Shower', [halfW - sideInset, 1.0, halfD * 0.15], [1.0, 2.0, 1.0], palette.furniture, 0.3, 0.03)
    addBox('Toilet', [0.6, 0.4, halfD * 0.25], [0.45, 0.8, 0.55], palette.warm, 0.48, 0.04)
  } else if (roomType === 'garage') {
    addBox('Car', [0, 0.75, 0.15], [2.3, 1.5, 4.1], palette.furniture, 0.55, 0.08)
    addBox('Storage', [halfW - sideInset, 1.1, -halfD * 0.25], [1.2, 2.2, 0.6], palette.accent, 0.68, 0.05)
    addBox('Workbench', [-halfW + sideInset, 0.9, halfD * 0.25], [1.6, 0.9, 0.7], palette.warm, 0.58, 0.06)
  } else {
    addBox('Sofa', [-0.9, 0.45, -furnitureZ], [2.2, 0.8, 1.0], palette.warm, 0.5, 0.05)
    addBox('Coffee Table', [0.8, 0.25, 0.1], [1.2, 0.45, 0.7], palette.furniture, 0.45, 0.05)
    addBox('TV Stand', [halfW - sideInset, 0.45, halfD * 0.1], [1.8, 0.55, 0.35], palette.accent, 0.55, 0.04)
  }

  return objects
}

/**
 * Tool definitions for OpenAI function calling
 */
export const AI_TOOLS = [
  {
    type: 'function',
    name: 'add_object',
    description: 'Add a new object to the design (box, wall, door, or window)',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['box', 'wall', 'door', 'window'],
          description: 'Type of object to add'
        },
        position: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Position in meters [x, y, z] where y is height from ground'
        },
        dimensions: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Dimensions in meters [width, height, depth]'
        },
        rotation: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Rotation in radians [x, y, z]'
        }
      },
      required: ['kind', 'position', 'dimensions']
    }
  },
  {
    type: 'function',
    name: 'add_wall',
    description: 'Add a wall to the design with standard wall properties',
    parameters: {
      type: 'object',
      properties: {
        position: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Position in meters [x, y, z]'
        },
        length: {
          type: 'number',
          description: 'Wall length in meters'
        },
        height: {
          type: 'number',
          default: 2.6,
          description: 'Wall height in meters (default 2.6m)'
        },
        rotation: {
          type: 'number',
          description: 'Rotation around Y axis in radians (0 = along X axis)'
        }
      },
      required: ['position', 'length']
    }
  },
  {
    type: 'function',
    name: 'generate_room',
    description: 'Generate a complete room layout with walls, a door, and basic furniture',
    parameters: {
      type: 'object',
      properties: {
        room_type: {
          type: 'string',
          enum: ['living_room', 'bedroom', 'kitchen', 'bathroom', 'office', 'dining_room', 'garage'],
          description: 'Type of room to generate'
        },
        width: {
          type: 'number',
          description: 'Room width in meters'
        },
        depth: {
          type: 'number',
          description: 'Room depth in meters'
        },
        style: {
          type: 'string',
          enum: ['modern', 'traditional', 'minimalist', 'industrial'],
          description: 'Design style for furniture and layout'
        }
      },
      required: ['room_type', 'width', 'depth']
    }
  },
  {
    type: 'function',
    name: 'modify_object',
    description: 'Modify an existing object\'s properties',
    parameters: {
      type: 'object',
      properties: {
        object_id: {
          type: 'string',
          description: 'ID of the object to modify'
        },
        position: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'New position [x, y, z]'
        },
        dimensions: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'New dimensions [width, height, depth]'
        },
        rotation: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'New rotation [x, y, z]'
        }
      },
      required: ['object_id']
    }
  },
  {
    type: 'function',
    name: 'delete_object',
    description: 'Delete an object from the design',
    parameters: {
      type: 'object',
      properties: {
        object_id: {
          type: 'string',
          description: 'ID of the object to delete'
        }
      },
      required: ['object_id']
    }
  },
  {
    type: 'function',
    name: 'get_current_design',
    description: 'Get information about the current design state',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
]

/**
 * System prompt for the AI assistant
 */
export const SYSTEM_PROMPT = `You are an expert home design assistant for Create Studio. Help users design custom homes by understanding their requests and using the available tools.

Your capabilities:
- Add individual objects (boxes, walls, doors, windows) with precise positioning
- Generate complete room layouts with appropriate furniture
- Modify existing objects
- Analyze current design state

Guidelines:
- All positions are in meters with [x, y, z] format where y is height from ground (0 = floor)
- Dimensions are in meters [width, height, depth]
- Rotation is in radians [x, y, z]
- Standard wall height is 2.6m
- Standard door height is 2.2m
- Standard window height is 1.1m
- When users say "feet", convert to meters (1 ft ≈ 0.3048m)
- Be precise with measurements
- Ask for clarification if a request is ambiguous
- Suggest improvements when appropriate

Common room sizes (in meters):
- Living room: 5x5 to 7x6
- Bedroom: 3x3 to 4x5
- Kitchen: 3x3 to 5x4
- Bathroom: 2x2 to 3x3
- Office: 3x3 to 4x4

Example requests:
- "Add a 4-meter wall at position [0, 1.3, 0] along the X axis"
- "Create a 5x6 living room with modern style"
- "Put a door at [2, 0, 0] facing south"
- "Move the box to [1, 0.5, 1]"

Always explain what you're doing before taking action.`

/**
 * Convert tool call arguments to StudioObject
 */
export function toolCallToObject(toolCall: any): StudioObject | null {
  const { name, function: func } = toolCall
  const args = parseToolCallArguments(func?.arguments)
  
  if (!args) return null
  
  if (name === 'add_object') {
    const { kind, position, dimensions, rotation } = args
    return {
      id: crypto.randomUUID(),
      kind,
      name: kind.charAt(0).toUpperCase() + kind.slice(1),
      position,
      scale: dimensions,
      rotation: rotation || [0, 0, 0],
      color: getDefaultColor(kind),
      opacity: getDefaultOpacity(kind),
      roughness: kind === 'wall' ? 0.7 : 0.05,
      metalness: 0.1,
    }
  }
  
  if (name === 'add_wall') {
    const { position, length, height = 2.6, rotation = 0 } = args
    return {
      id: crypto.randomUUID(),
      kind: 'wall',
      name: 'Wall',
      position: [position[0], height / 2, position[2]],
      scale: [length, height, 0.2],
      rotation: [0, rotation, 0],
      color: '#d8d8d8',
      opacity: 1,
      roughness: 0.7,
      metalness: 0.1,
    }
  }
  
  return null
}

/**
 * Convert a tool call into one or more StudioObject entries.
 */
export function toolCallToObjects(toolCall: any): StudioObject[] {
  const { name, function: func } = toolCall
  const args = parseToolCallArguments(func?.arguments)
  if (!args) return []

  if (name === 'generate_room') {
    return buildRoomLayout(args)
  }

  const single = toolCallToObject(toolCall)
  return single ? [single] : []
}

/**
 * Return a human-readable label for AI action feedback.
 */
export function summarizeToolCall(toolCall: any): string {
  const { name, function: func } = toolCall
  const args = parseToolCallArguments(func?.arguments)

  if (name === 'generate_room') {
    const roomType = String(args?.room_type || 'room').replaceAll('_', ' ')
    return `Generated ${roomType}`
  }

  if (name === 'add_wall') return 'Added wall'
  if (name === 'add_object') return `Added ${String(args?.kind || 'object')}`
  if (name === 'modify_object') return 'Modified object'
  if (name === 'delete_object') return 'Deleted object'
  if (name === 'get_current_design') return 'Reviewed current design'

  return name ? `Ran ${name}` : 'Ran AI tool'
}

/**
 * Get default color for object kind
 */
function getDefaultColor(kind: PrimitiveKind): string {
  const colors = {
    box: '#c8c8c8',
    wall: '#d8d8d8',
    door: '#86b7ff',
    window: '#a9d7ff',
  }
  return colors[kind] || '#c8c8c8'
}

/**
 * Get default opacity for object kind
 */
function getDefaultOpacity(kind: PrimitiveKind): number {
  const opacities = {
    box: 1,
    wall: 1,
    door: 0.22,
    window: 0.2,
  }
  return opacities[kind] || 1
}

/**
 * Parse natural language dimensions to meters
 */
export function parseDimension(input: string): number {
  const match = input.toLowerCase().match(/(\d+\.?\d*)\s*(ft|feet|m|meters?)/)
  if (!match) return 1
  
  const value = parseFloat(match[1])
  const unit = match[2]
  
  if (unit.startsWith('f')) {
    // Convert feet to meters
    return value * 0.3048
  }
  
  return value // Already in meters
}
