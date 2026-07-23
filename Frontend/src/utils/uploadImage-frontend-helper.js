// Frontend/src/utils/uploadImage.js

const API =
  window.API ||
  window.BACKEND ||
  'https://anistrimbackend.onrender.com';

export async function uploadImage(file, endpoint = '/api/admin/upload/anime', token) {
  if (!file) throw new Error('Please choose an image first.');

  const formData = new FormData();
  formData.append('image', file);

  const authToken =
    token ||
    localStorage.getItem('token') ||
    localStorage.getItem('authToken');

  const headers = {};
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const url = endpoint.startsWith('http')
    ? endpoint
    : `${API}${endpoint}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: formData,
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_err) {
    data = null;
  }

  if (!response.ok || !data || data.success === false) {
    throw new Error((data && data.message) || `Upload failed with status ${response.status}.`);
  }

  const imageUrl =
    data.url ||
    data.imageUrl ||
    data.image_url ||
    data.secure_url ||
    data.path;

  if (!imageUrl) {
    throw new Error('Upload worked, but no image URL came back from the backend.');
  }

  return { ...data, url: imageUrl };
}