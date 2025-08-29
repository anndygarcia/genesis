export type Tool = 'select' | 'pan' | 'wall' | 'room' | 'rotate';

export type Vec2 = { x: number; y: number };

export type Wall = {
  id: string;
  a: Vec2;
  b: Vec2;
  thickness: number; // in cm
};

export type Room = {
  id: string;
  points: Vec2[]; // polygon in canvas units (cm)
  name?: string;
};

export type Plan = {
  walls: Wall[];
  rooms: Room[];
};

export type Viewport = {
  zoom: number; // pixels per cm
  offset: Vec2; // pan in pixels
};

export type GeneratorInput = {
  bedrooms: number;
  bathrooms: number;
  garageSpots: number;
  sqft: number;
  style: 'modern' | 'traditional' | 'ranch' | 'colonial';
};
