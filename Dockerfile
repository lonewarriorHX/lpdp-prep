FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy static site files (exclude non-deployable dirs)
COPY index.html /usr/share/nginx/html/
COPY login.html /usr/share/nginx/html/
COPY account.html /usr/share/nginx/html/
COPY essay.html /usr/share/nginx/html/
COPY interview.html /usr/share/nginx/html/
COPY tbs.html /usr/share/nginx/html/
COPY history.html /usr/share/nginx/html/
COPY pricing.html /usr/share/nginx/html/
COPY admin.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY images/ /usr/share/nginx/html/images/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
