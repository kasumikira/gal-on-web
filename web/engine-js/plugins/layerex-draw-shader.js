export const VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 position;
layout(location = 1) in vec4 vertexColour;
uniform vec2 targetSize;
out vec4 colour;
void main() {
  vec2 clip = position / targetSize * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  colour = vertexColour;
}`;

export const FRAGMENT = `#version 300 es
precision highp float;
in vec4 colour;
out vec4 outputColour;
void main() { outputColour = colour; }`;
